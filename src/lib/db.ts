// db.ts — web-pi's persisted state: one SQLite file (node:sqlite).
//
// Everything the app itself writes lives in ENV.WEB_PI_DB_FILE (default
// <state dir>/webpi.db): the login credential (single row), the login
// sessions (`auth_sessions` — token hashes only, src/lib/auth.ts), a
// `sessions` overlay table, the scheduled-jobs tables (`jobs` definitions,
// `job_runs` bookkeeping — src/lib/jobs.ts), and a small `settings` kv
// (src/lib/auto-update.ts). pi's own store (sessions/,
// provider creds under WEB_PI_AGENT_DIR) is not web-pi state and stays
// untouched.
//
// - node:sqlite's DatabaseSync is synchronous on purpose: every call here
//   is a point query on a tiny table — cheaper than the whole-file JSON
//   reads it replaces, and reads stay fail-closed the way the files were.
// - No WAL: one plain file that behaves on any volume (WAL's -wal/-shm
//   sidecars are the classic network-storage footgun — see TODO.md).
// - The connection opens lazily on first use, like the old JSON files:
//   the e2e webServer boots before global-setup resets its workspace, so
//   an eager open would latch (and orphan) a db the reset then deletes.
//
// - Queries are typed with Kysely, used as a query BUILDER only: `qb`
//   compiles against the StateSchema interfaces below and StateDb runs the
//   SQL on its own synchronous connection (all/get/run). Kysely's own
//   execute() is async — it would make every caller async for nothing.
//
// NB: node:sqlite still prints a one-line ExperimentalWarning when it
// first loads (server boot, set-password, e2e output). Expected — see
// AGENTS.md.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler,
  type Compilable, type DatabaseConnection,
} from 'kysely';
import type { ResultFailure, ResultSuccess } from '../types/result';
import type { JobName, PiSessionId } from '../types/branded';

/** The shared "generic update" result: a write that only reports how many
 *  rows it touched (setters, deletes, flag flips). */
export type DatabaseUpdateData = { changes: number };
export type DatabaseUpdateErrorCode = 'database_error';
export type DatabaseUpdateSuccess = ResultSuccess<'database_update', DatabaseUpdateData>;
export type DatabaseUpdateFailure = ResultFailure<'database_update', DatabaseUpdateData, DatabaseUpdateErrorCode>;
export type DatabaseUpdateResult = DatabaseUpdateSuccess | DatabaseUpdateFailure;

/** Run one write at the db boundary: a thrown sqlite error (lock
 *  timeout, unwritable file, a db deleted under us) becomes a
 *  database_error failure instead of propagating. `context` prefixes the
 *  message ("could not save hidden state: …"). */
export function databaseUpdate(context: string, write: () => { changes: number | bigint }) {
  try {
    const { changes } = write();
    return { ok: true, resultType: 'database_update', data: { changes: Number(changes) } } satisfies DatabaseUpdateSuccess;
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
export type DatabaseReadFailure<T> = ResultFailure<'database_read', DatabaseReadData<T>, DatabaseReadErrorCode>;
export type DatabaseReadResult<T> = DatabaseReadSuccess<T> | DatabaseReadFailure<T>;

/** Run one read at the db boundary — databaseUpdate()'s twin for queries:
 *  a thrown sqlite error becomes a database_error failure. */
export function databaseRead<T>(context: string, read: () => T) {
  try {
    return { ok: true, resultType: 'database_read', data: { value: read() } } satisfies DatabaseReadSuccess<T>;
  } catch (err) {
    return {
      ok: false,
      resultType: 'database_read',
      errorCode: 'database_error',
      errorMessage: `${context}: ${(err as Error).message}`,
    } satisfies DatabaseReadFailure<T>;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS credential (
    id         INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
    username   TEXT    NOT NULL,
    salt       TEXT    NOT NULL,   -- hex
    hash       TEXT    NOT NULL,   -- hex, scrypt
    updated_at INTEGER NOT NULL
  );
  -- Overlay on pi's session store: the fs store stays the truth for a
  -- session's existence; rows appear here only where web-pi has an
  -- opinion to record (hidden today; app_id/display_name/pinned later).
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT    PRIMARY KEY,  -- pi's id
    hidden_at  INTEGER                -- NULL = visible
  );
  -- Scheduled-job definitions for the in-process scheduler
  -- (src/lib/jobs.ts). command is an arbitrary shell string BY DESIGN
  -- (typed by the authenticated user) — it only ever reaches tmux as
  -- tmux's own command string, never a server-side shell.
  CREATE TABLE IF NOT EXISTS jobs (
    name       TEXT    PRIMARY KEY,  -- JOB_NAME_RE (src/schemas/patterns.ts)
    schedule   TEXT    NOT NULL,     -- 5-field cron
    command    TEXT    NOT NULL,
    created_at INTEGER NOT NULL      -- epoch ms; catch-up reference until the first fire
  );
  -- One row per fired run (scheduler tick, boot catch-up, or "run now").
  -- MAX(fired_at) per job is its last-fired: what boot catch-up compares
  -- against the schedule (systemd Persistent=true equivalent).
  CREATE TABLE IF NOT EXISTS job_runs (
    job      TEXT    NOT NULL,
    fired_at INTEGER NOT NULL,       -- epoch ms the run's tmux session opened
    origin   TEXT    NOT NULL        -- 'schedule' | 'catchup' | 'manual'
  );
  CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs (job, fired_at);
  -- Small app-settings kv (one row per key, JSON-encoded values). Keys
  -- are owned by their module (today: pi auto-update, src/lib/auto-update.ts).
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Login sessions (src/lib/auth.ts), so a restart doesn't sign everyone
  -- out. Keyed by sha256(token): the raw token never touches disk, so a
  -- copied db (or backup) holds nothing a browser could present.
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT    PRIMARY KEY,  -- hex sha256 of the cookie token
    created_at INTEGER NOT NULL,     -- epoch ms of login: the absolute cap's origin
    expires_at INTEGER NOT NULL,     -- sliding idle expiry (renewal writes throttled)
    cookie_at  INTEGER NOT NULL      -- when a Set-Cookie last re-armed the browser's Max-Age
  );
`;

// ---------- the schema, as Kysely sees it (keep in step with SCHEMA) ----------
// Branded columns: the state db is a trusted source (src/types/branded.ts)
// — ids are validated before they're written, so rows read back branded.

/** How a job run was fired (job_runs.origin). */
export type JobRunOrigin = 'schedule' | 'catchup' | 'manual';

export interface CredentialTable {
  id: 1;
  username: string;
  salt: string;
  hash: string;
  updated_at: number;
}
export interface SessionsTable {
  session_id: PiSessionId;
  hidden_at: number | null;
}
export interface JobsTable {
  name: JobName;
  schedule: string;
  command: string;
  created_at: number;
}
export interface JobRunsTable {
  job: JobName;
  fired_at: number;
  origin: JobRunOrigin;
}
export interface SettingsTable {
  key: string;
  value: string;
}
export interface AuthSessionsTable {
  token_hash: string;
  created_at: number;
  expires_at: number;
  cookie_at: number;
}
export interface StateSchema {
  credential: CredentialTable;
  sessions: SessionsTable;
  jobs: JobsTable;
  job_runs: JobRunsTable;
  settings: SettingsTable;
  auth_sessions: AuthSessionsTable;
}

/** Kysely's DummyDriver answers every execute() with zero rows — a query
 *  run through `qb` by mistake would silently read as "nothing there".
 *  This one throws instead: queries only run via StateDb.all/get/run. */
class CompileOnlyDriver extends DummyDriver {
  override async acquireConnection(): Promise<DatabaseConnection> {
    throw new Error('qb only compiles queries — run them with StateDb.all/get/run');
  }
}

/** The typed query builder for the state db (compile-only; see the
 *  module comment). Stateless — safe to share across StateDb instances. */
export const qb = new Kysely<StateSchema>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new CompileOnlyDriver(),
    createIntrospector: db => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

/** web-pi's state database: a lazily-opened node:sqlite connection (see
 *  module comment) plus cached prepared statements. */
export class StateDb {
  private conn: DatabaseSync | null = null;
  private stmts = new Map<string, StatementSync>();

  constructor(readonly file: string) {}

  /** The connection — dir and schema happen on first use. */
  db(): DatabaseSync {
    if (this.conn) return this.conn;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fresh = !fs.existsSync(this.file);
    const db = new DatabaseSync(this.file);
    try {
      // set-password (its own process) may write while the server holds
      // the db open — let sqlite wait out the lock instead of failing.
      db.exec('PRAGMA busy_timeout = 3000');
      db.exec(SCHEMA);
      // user_version: 1 = credential + sessions; 2 adds the job tables;
      // 3 adds the settings kv table; 4 adds auth_sessions (additive — the
      // CREATE IF NOT EXISTS block above brings any older db up to v4
      // shape; nothing is dropped).
      const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (v.user_version < 4) db.exec('PRAGMA user_version = 4');
      else if (v.user_version > 4) {
        throw new Error(`state db ${this.file} is schema v${v.user_version} — newer than this build understands`);
      }
      if (fresh) fs.chmodSync(this.file, 0o600); // it holds the password hash
      this.conn = db;
      return db;
    } catch (err) {
      try { db.close(); } catch { /* never got open */ }
      throw err as Error;
    }
  }

  /** Prepared statement, compiled once per connection (keyed by SQL text:
   *  a Kysely query compiles to the same text every call, values bound as
   *  parameters). Opens the db if needed. */
  private stmt<R>(query: Compilable<R>): { stmt: StatementSync; params: SQLInputValue[] } {
    const { sql, parameters } = query.compile();
    let s = this.stmts.get(sql);
    if (!s) { s = this.db().prepare(sql); this.stmts.set(sql, s); }
    // Kysely only passes on the values our schema types allow (strings,
    // numbers, null) — all bindable as-is.
    return { stmt: s, params: parameters as SQLInputValue[] };
  }

  // The typed execution half of `qb`. These throw on a sqlite error, like
  // node:sqlite itself: callers wrap them in databaseRead()/databaseUpdate()
  // — the boundary (docs/CODE_STYLE.md §2).

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

  /** Read one app-settings value (settings kv table); null when unset. */
  getSetting(key: string): string | null {
    return this.get(qb.selectFrom('settings').select('value').where('key', '=', key))?.value ?? null;
  }

  /** Write one app-settings value. Throws on db failure — callers wrap it
   *  in databaseUpdate() so failure reaches the user as a Result (the API
   *  500s instead of lying). */
  setSetting(key: string, value: string): { changes: number | bigint } {
    return this.run(qb.insertInto('settings').values({ key, value })
      .onConflict(oc => oc.column('key').doUpdateSet(eb => ({ value: eb.ref('excluded.value') }))));
  }
}
