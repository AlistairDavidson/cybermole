// node:sqlite helpers for an app's own db (cybermole's state db extends them).
// - Synchronous DatabaseSync on purpose: point queries on small tables.
// - No WAL: its -wal/-shm sidecars misbehave on network storage.
// - Opens lazily on first use. If the file is replaced under an open
//   connection (a test reset, a restored backup), the swap is detected by
//   inode and the connection reopens; the old inode would read stale rows
//   and fail writes with SQLITE_READONLY. A deleted file keeps serving its
//   inode, so writes fail loudly.
// - Kysely is a query builder only (its execute() is async); SqliteDb runs
//   the compiled SQL synchronously.
// - databaseRead()/databaseUpdate() turn thrown sqlite errors into
//   database_error Results.
//
// node:sqlite's ExperimentalWarning on first load is expected.
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

/** A write that only reports how many rows it touched. */
export type DatabaseUpdateData = { changes: number };
export type DatabaseUpdateErrorCode = 'database_error';
export type DatabaseUpdateSuccess = ResultSuccess<'database_update', DatabaseUpdateData>;
export type DatabaseUpdateFailure = ResultFailure<
  'database_update',
  DatabaseUpdateData,
  DatabaseUpdateErrorCode
>;
export type DatabaseUpdateResult = DatabaseUpdateSuccess | DatabaseUpdateFailure;

/** `context` prefixes the message ("could not save hidden state: …"). */
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

/** A read whose answer the caller shapes itself. */
export type DatabaseReadData<T> = { value: T };
export type DatabaseReadErrorCode = 'database_error';
export type DatabaseReadSuccess<T> = ResultSuccess<'database_read', DatabaseReadData<T>>;
export type DatabaseReadFailure<T> = ResultFailure<
  'database_read',
  DatabaseReadData<T>,
  DatabaseReadErrorCode
>;
export type DatabaseReadResult<T> = DatabaseReadSuccess<T> | DatabaseReadFailure<T>;

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

/** Kysely's DummyDriver answers every execute() with zero rows, so a query
 *  run through the builder by mistake would read as empty. This throws. */
class CompileOnlyDriver extends DummyDriver {
  override async acquireConnection(): Promise<DatabaseConnection> {
    throw new Error('the query builder only compiles queries — run them with SqliteDb.all/get/run');
  }
}

/** Compile-only and stateless; safe to share across instances. */
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

/** Everything runs at every open, so must be idempotent. */
export interface SqliteDbOptions {
  /** CREATE TABLE IF NOT EXISTS … */
  schema: string;
  /** Guarded ALTERs, idempotent DROPs. */
  migrate?: (db: DatabaseSync) => void;
  /** Older files are brought up; a newer file refuses to open, since this
   *  build might drop rows it doesn't know. */
  version: number;
  /** chmod for a freshly created file (the state db's 0o600 for its password hash). */
  freshMode?: number;
  /** Names the db in the newer-version refusal. */
  label?: string;
}

/** A lazily opened connection with cached prepared statements. */
export class SqliteDb {
  private conn: DatabaseSync | null = null;
  private stmts = new Map<string, StatementSync>();
  /** For replaced-file detection. */
  private openedOn: { dev: number; ino: number } | null = null;

  constructor(
    readonly file: string,
    private readonly options: SqliteDbOptions,
  ) {}

  db(): DatabaseSync {
    if (this.conn !== null) {
      // Adopt a replaced file. If the path is gone, keep serving the open
      // inode rather than silently creating a fresh file.
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
        /* path gone */
      }
      if (this.conn !== null) return this.conn;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fresh = !fs.existsSync(this.file);
    const db = new DatabaseSync(this.file);
    try {
      // Wait out locks from a second writer (set-password) instead of failing.
      db.exec('PRAGMA busy_timeout = 3000');
      // On by default in node:sqlite, but cascades depend on it, so be explicit.
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

  /** A replaced file is a different db: its cached statements must go too. */
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

  /** Cached by SQL text (Kysely binds values as parameters). Calls db()
   *  first every time, so a cached statement never bypasses the
   *  replaced-file check. */
  private stmt<R>(query: Compilable<R>): { stmt: StatementSync; params: SQLInputValue[] } {
    const { sql, parameters } = query.compile();
    this.db();
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db().prepare(sql);
      this.stmts.set(sql, s);
    }
    // Kysely only passes values the schema types allow, all bindable as-is.
    return { stmt: s, params: parameters as SQLInputValue[] };
  }

  // These throw on sqlite errors; callers wrap them in databaseRead()/databaseUpdate().

  all<R>(query: Compilable<R>): R[] {
    const { stmt, params } = this.stmt(query);
    return stmt.all(...params) as R[];
  }

  /** undefined when there's no row */
  get<R>(query: Compilable<R>): R | undefined {
    const { stmt, params } = this.stmt(query);
    return stmt.get(...params) as R | undefined;
  }

  run(query: Compilable<unknown>): { changes: number | bigint } {
    const { stmt, params } = this.stmt(query);
    return stmt.run(...params);
  }
}
