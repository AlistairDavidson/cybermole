// sqlite.ts — the node:sqlite db helper pattern an app's own data/app.db
// uses (docs/plans/apps-plan.md §2/§5), extracted from cybermole's state db
// (src/lib/db.ts) by task/app-kit: the console keeps its schema and
// migrations there and extends the kit's class here.
//
// The pattern (why each piece is the way it is — same reasoning as the
// state db's):
// - node:sqlite's DatabaseSync is synchronous on purpose: point queries on
//   small tables, fail-closed reads.
// - No WAL: one plain file that behaves on any volume (WAL's -wal/-shm
//   sidecars are the classic network-storage footgun).
// - The connection opens lazily on first use: an eager open can latch
//   (and orphan) a db file a later reset deletes — and if the latch
//   happens anyway (something legitimately reads at boot), a REPLACED
//   file (a test's workspace reset, an operator restoring a backup) is
//   adopted at the next use: the old inode would read stale rows and
//   fail every write with SQLITE_READONLY, so the swap is detected by
//   inode and the connection (plus its cached statements) reopens on
//   the new file. A file deleted WITHOUT a replacement keeps serving
//   the open inode — reads still work, writes fail loudly.
// - Queries are typed with Kysely, used as a query BUILDER only: createQb()
//   compiles against the app's schema interfaces and the SqliteDb below
//   runs the SQL on its own synchronous connection (all/get/run). Kysely's
//   own execute() is async — it would make every caller async for nothing.
// - databaseRead()/databaseUpdate() are the db boundary for callers: a
//   thrown sqlite error becomes a database_error failure Result instead of
//   propagating (docs/conventions/CODE_STYLE.md §2).
//
// NB: node:sqlite still prints a one-line ExperimentalWarning when it first
// loads. Expected.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
  type DatabaseConnection,
} from 'kysely';
import type { ResultFailure, ResultSuccess } from '../types/result';

/** The shared "generic update" result: a write that only reports how many
 *  rows it touched (setters, deletes, flag flips). */
export type DatabaseUpdateData = { changes: number };
export type DatabaseUpdateErrorCode = 'database_error';
export type DatabaseUpdateSuccess = ResultSuccess<'database_update', DatabaseUpdateData>;
export type DatabaseUpdateFailure = ResultFailure<
  'database_update',
  DatabaseUpdateData,
  DatabaseUpdateErrorCode
>;
export type DatabaseUpdateResult = DatabaseUpdateSuccess | DatabaseUpdateFailure;

/** Run one write at the db boundary: a thrown sqlite error (lock
 *  timeout, unwritable file, a db deleted under us) becomes a
 *  database_error failure instead of propagating. `context` prefixes the
 *  message ("could not save hidden state: …"). */
export function databaseUpdate(context: string, write: () => { changes: number | bigint }) {
  try {
    const { changes } = write();
    return {
      ok: true,
      resultType: 'database_update',
      data: { changes: Number(changes) },
    } satisfies DatabaseUpdateSuccess;
  } catch (err) {
    return {
      ok: false,
      resultType: 'database_update',
      errorCode: 'database_error',
      errorMessage: `${context}: ${(err as Error).message}`,
    } satisfies DatabaseUpdateFailure;
  }
}

/** The shared "generic read" result: a query whose answer the caller
 *  shapes itself (a row, a list, an aggregate). */
export type DatabaseReadData<T> = { value: T };
export type DatabaseReadErrorCode = 'database_error';
export type DatabaseReadSuccess<T> = ResultSuccess<'database_read', DatabaseReadData<T>>;
export type DatabaseReadFailure<T> = ResultFailure<
  'database_read',
  DatabaseReadData<T>,
  DatabaseReadErrorCode
>;
export type DatabaseReadResult<T> = DatabaseReadSuccess<T> | DatabaseReadFailure<T>;

/** Run one read at the db boundary — databaseUpdate()'s twin for queries:
 *  a thrown sqlite error becomes a database_error failure. */
export function databaseRead<T>(context: string, read: () => T) {
  try {
    return {
      ok: true,
      resultType: 'database_read',
      data: { value: read() },
    } satisfies DatabaseReadSuccess<T>;
  } catch (err) {
    return {
      ok: false,
      resultType: 'database_read',
      errorCode: 'database_error',
      errorMessage: `${context}: ${(err as Error).message}`,
    } satisfies DatabaseReadFailure<T>;
  }
}

/** Kysely's DummyDriver answers every execute() with zero rows — a query
 *  run through the builder by mistake would silently read as "nothing
 *  there". This one throws instead: queries only run via SqliteDb.all/
 *  get/run. */
class CompileOnlyDriver extends DummyDriver {
  override async acquireConnection(): Promise<DatabaseConnection> {
    throw new Error('the query builder only compiles queries — run them with SqliteDb.all/get/run');
  }
}

/** The typed query builder for a schema (compile-only; see the module
 *  comment). Stateless — safe to share across SqliteDb instances. */
export function createQb<Schema>(): Kysely<Schema> {
  return new Kysely<Schema>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new CompileOnlyDriver(),
      createIntrospector: db => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}

/** What open() does with the file, beyond opening it. Everything is
 *  idempotent (runs at every open), matching the state db's shape. */
export interface SqliteDbOptions {
  /** Complete DDL: CREATE TABLE IF NOT EXISTS … — runs at every open. */
  schema: string;
  /** Migration steps on top of `schema` (guarded ALTERs, idempotent
   *  DROPs), run at every open. */
  migrate?: (db: DatabaseSync) => void;
  /** The schema version this build understands: an older file is brought
   *  up (by schema+migrate), a newer file refuses to open — it may contain
   *  rows this build would drop. */
  version: number;
  /** chmod applied to a FRESHLY created file (it may hold secrets — the
   *  console's state db passes 0o600 for its password hash). */
  freshMode?: number;
  /** The subject of the newer-than-this-build refusal message ("state db
   *  /x/y.db is schema v9 — …"). */
  label?: string;
}

/** A lazily-opened node:sqlite connection with cached prepared statements,
 *  executing Kysely-compiled queries synchronously (see the module
 *  comment). cybermole's StateDb extends this with its own schema and
 *  settings accessors; an app's own data/app.db uses it directly. */
export class SqliteDb {
  private conn: DatabaseSync | null = null;
  private stmts = new Map<string, StatementSync>();
  /** dev+ino of the file this.conn was opened on — the replaced-file
   *  detection below compares against it. */
  private openedOn: { dev: number; ino: number } | null = null;

  constructor(
    readonly file: string,
    private readonly options: SqliteDbOptions,
  ) {}

  /** The connection — dir, schema and migrations happen on first use. */
  db(): DatabaseSync {
    if (this.conn !== null) {
      // The latch case (module comment): something replaced the file under
      // the open connection — adopt the new one. A stat that throws (the
      // path is gone) keeps the open connection: a DELETED db serves its
      // inode until it fails loudly on write, never a silent fresh file.
      try {
        const st = fs.statSync(this.file);
        if (
          this.openedOn === null ||
          st.dev !== this.openedOn.dev ||
          st.ino !== this.openedOn.ino
        ) {
          this.dropConn();
        }
      } catch {
        /* path gone — keep the open inode */
      }
      if (this.conn !== null) return this.conn;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fresh = !fs.existsSync(this.file);
    const db = new DatabaseSync(this.file);
    try {
      // A second process may write while we hold the db open (the console's
      // set-password does) — let sqlite wait out the lock instead of failing.
      db.exec('PRAGMA busy_timeout = 3000');
      // node:sqlite opens with foreign_keys ON by default, but a schema's
      // whole delete story can rest on FKs (cascades, SET NULL) — never on a
      // Node default, so it is set explicitly (a no-op outside transactions).
      db.exec('PRAGMA foreign_keys = 1');
      db.exec(this.options.schema);
      this.options.migrate?.(db);
      const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (v.user_version < this.options.version)
        db.exec(`PRAGMA user_version = ${this.options.version}`);
      else if (v.user_version > this.options.version) {
        throw new Error(
          `${this.options.label ?? 'database'} ${this.file} is schema v${v.user_version} — newer than this build understands`,
        );
      }
      if (fresh && this.options.freshMode !== undefined)
        fs.chmodSync(this.file, this.options.freshMode);
      this.conn = db;
      this.openedOn = fs.statSync(this.file);
      return db;
    } catch (err) {
      try {
        db.close();
      } catch {
        /* never got open */
      }
      throw err as Error;
    }
  }

  /** Forget the open connection + its cached statements (a replaced file
   *  is a different database — its statements must not survive it). */
  private dropConn(): void {
    try {
      this.conn?.close();
    } catch {
      /* already gone */
    }
    this.conn = null;
    this.openedOn = null;
    this.stmts.clear();
  }

  /** Prepared statement, compiled once per connection (keyed by SQL text:
   *  a Kysely query compiles to the same text every call, values bound as
   *  parameters). Runs db() FIRST on every query — that is where the
   *  replaced-file check lives, and a cached statement must never bypass
   *  it (a swapped file's statements are the swap's first victim). */
  private stmt<R>(query: Compilable<R>): { stmt: StatementSync; params: SQLInputValue[] } {
    const { sql, parameters } = query.compile();
    this.db();
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db().prepare(sql);
      this.stmts.set(sql, s);
    }
    // Kysely only passes on the values the schema types allow (strings,
    // numbers, null) — all bindable as-is.
    return { stmt: s, params: parameters as SQLInputValue[] };
  }

  // The typed execution half of createQb(). These throw on a sqlite error,
  // like node:sqlite itself: callers wrap them in databaseRead()/
  //  databaseUpdate() — the boundary (docs/conventions/CODE_STYLE.md §2).

  /** Every row a select returns, typed by the query. */
  all<R>(query: Compilable<R>): R[] {
    const { stmt, params } = this.stmt(query);
    return stmt.all(...params) as R[];
  }

  /** The first row a select returns (undefined when there is none). */
  get<R>(query: Compilable<R>): R | undefined {
    const { stmt, params } = this.stmt(query);
    return stmt.get(...params) as R | undefined;
  }

  /** Run a write (insert/update/delete); reports the rows it touched. */
  run(query: Compilable<unknown>): { changes: number | bigint } {
    const { stmt, params } = this.stmt(query);
    return stmt.run(...params);
  }
}
