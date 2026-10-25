// cybermole's persisted state: one SQLite file (node:sqlite). pi's own store
// under the agent dir is not ours and is never touched.
//
// - Synchronous DatabaseSync on purpose: every query is a point query on a
//   tiny table.
// - No WAL: its -wal/-shm sidecars misbehave on network storage.
// - Opens lazily on first use: the e2e webServer boots before global-setup
//   resets its workspace, so an eager open would latch a db that's then deleted.
// - Kysely is a query builder only; its execute() is async, so StateDb runs
//   the compiled SQL on its own sync connection.
//
// The generic connection and query helpers live in @cybermole/app-kit.
// node:sqlite's ExperimentalWarning on first load is expected.
import { type DatabaseSync } from 'node:sqlite';
import { createQb, SqliteDb } from '@cybermole/app-kit';
import type { AppId, AppSlug, JobName, TerminalId, WorkspaceId } from '@cybermole/app-kit';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS credential (
    id         INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
    username   TEXT    NOT NULL,
    salt       TEXT    NOT NULL,   -- hex
    hash       TEXT    NOT NULL,   -- hex, scrypt
    updated_at INTEGER NOT NULL
  );
  -- Leftover pi-session overlay; idempotent.
  DROP TABLE IF EXISTS sessions;
  -- apps 1—M workspaces 1—M terminals; the console is the NULL app.
  -- Cascades do structural deletes; jobs are only tagged (SET NULL).
  CREATE TABLE IF NOT EXISTS apps (
    id         TEXT PRIMARY KEY,     -- uuid v4 (crypto.randomUUID) → AppId
    name       TEXT NOT NULL,        -- display name, free text
    slug       TEXT NOT NULL UNIQUE, -- APP_SLUG_RE (the kit's schemas/patterns.ts)
    cwd        TEXT,                 -- where its workspaces start; NULL = server default
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,     -- epoch ms
    updated_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,        -- username; single-user login today
    updated_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id         TEXT PRIMARY KEY,     -- uuid v4 → WorkspaceId
    app_id     TEXT REFERENCES apps(id) ON DELETE CASCADE,  -- NULL = console
    name       TEXT NOT NULL,        -- free text, sidebar label
    cwd        TEXT NOT NULL,        -- terminal spawn dir + editor folder
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workspaces_by_app ON workspaces (app_id, sort_order);
  CREATE TABLE IF NOT EXISTS terminals (
    id           TEXT PRIMARY KEY,   -- uuid v4 → TerminalId
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title        TEXT,               -- NULL → UI labels "term N"
    sort_order   INTEGER NOT NULL,   -- tab order; append = max+10
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    created_by   TEXT NOT NULL,
    updated_by   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS terminals_by_workspace ON terminals (workspace_id, sort_order);
  -- command is arbitrary shell by design; it only reaches tmux as argv.
  CREATE TABLE IF NOT EXISTS jobs (
    name       TEXT    PRIMARY KEY,  -- JOB_NAME_RE (the kit's schemas/patterns.ts)
    schedule   TEXT    NOT NULL,     -- 5-field cron
    command    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,     -- epoch ms; catch-up reference until the first fire
    app_id     TEXT    REFERENCES apps(id) ON DELETE SET NULL  -- a tag, never ownership
  );
  -- One row per fired run. The newest fired_at per job is the catch-up reference.
  CREATE TABLE IF NOT EXISTS job_runs (
    job         TEXT    NOT NULL,
    fired_at    INTEGER NOT NULL,       -- epoch ms the run's tmux session opened
    origin      TEXT    NOT NULL,       -- 'schedule' | 'catchup' | 'manual'
    log         TEXT,                   -- log file path; NULL = no log
    exit_code   INTEGER,                -- filled when the finish is observed
    finished_at INTEGER                 -- ditto
  );
  CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs (job, fired_at);
  -- Keys are owned by their modules (auto-update, terminal defaults).
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Keyed by sha256(token) so a copied db holds nothing a browser could present.
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT    PRIMARY KEY,  -- hex sha256 of the cookie token
    created_at INTEGER NOT NULL,     -- epoch ms of login: the absolute cap's origin
    expires_at INTEGER NOT NULL,     -- sliding idle expiry (renewal writes throttled)
    cookie_at  INTEGER NOT NULL      -- when a Set-Cookie last re-armed the browser's Max-Age
  );
`;

// ---------- schema as Kysely sees it (keep in step with SCHEMA) ----------
// Columns come back branded: ids are validated before they're written.

export type JobRunOrigin = 'schedule' | 'catchup' | 'manual';

export interface CredentialTable {
  id: 1;
  username: string;
  salt: string;
  hash: string;
  updated_at: number;
}
export interface AppsTable {
  id: AppId;
  name: string;
  slug: AppSlug;
  /** NULL = the configured default. */
  cwd: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  updated_by: string;
}
export interface WorkspacesTable {
  id: WorkspaceId;
  /** NULL = the console. */
  app_id: AppId | null;
  name: string;
  cwd: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  updated_by: string;
}
export interface TerminalsTable {
  id: TerminalId;
  workspace_id: WorkspaceId;
  /** NULL → labelled "term N". */
  title: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  updated_by: string;
}
export interface JobsTable {
  name: JobName;
  schedule: string;
  command: string;
  created_at: number;
  /** A tag, never ownership. */
  app_id: AppId | null;
}
export interface JobRunsTable {
  job: JobName;
  fired_at: number;
  origin: JobRunOrigin;
  /** NULL = no log; exit_code and finished_at fill when the finish is observed. */
  log: string | null;
  exit_code: number | null;
  finished_at: number | null;
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
  apps: AppsTable;
  workspaces: WorkspacesTable;
  terminals: TerminalsTable;
  jobs: JobsTable;
  job_runs: JobRunsTable;
  settings: SettingsTable;
  auth_sessions: AuthSessionsTable;
}

/** Stateless; safe to share across StateDb instances. */
export const qb = createQb<StateSchema>();

/** ADD COLUMN isn't idempotent, so check PRAGMA table_info rather than the
 *  version: a fresh db already has the columns from CREATE. Names are
 *  module constants, never user input. */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/** Additive columns added after their tables first shipped. Runs at every
 *  open; each ALTER is guarded by the column check. */
function migrateToV6(db: DatabaseSync): void {
  addColumnIfMissing(db, 'jobs', 'app_id', 'TEXT REFERENCES apps(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'job_runs', 'log', 'TEXT');
  addColumnIfMissing(db, 'job_runs', 'exit_code', 'INTEGER');
  addColumnIfMissing(db, 'job_runs', 'finished_at', 'INTEGER');
  addColumnIfMissing(db, 'apps', 'cwd', 'TEXT');
}

export class StateDb extends SqliteDb {
  constructor(file: string) {
    super(file, {
      schema: SCHEMA,
      migrate: migrateToV6,
      // CREATE IF NOT EXISTS + migrateToV6 bring any older db to the current shape.
      version: 6,
      freshMode: 0o600, // it holds the password hash
      label: 'state db',
    });
  }

  getSetting(key: string): string | null {
    return (
      this.get(qb.selectFrom('settings').select('value').where('key', '=', key))?.value ?? null
    );
  }

  /** Throws on db failure; callers wrap it in databaseUpdate(). */
  setSetting(key: string, value: string): { changes: number | bigint } {
    return this.run(
      qb
        .insertInto('settings')
        .values({ key, value })
        .onConflict(oc =>
          oc.column('key').doUpdateSet(eb => ({ value: eb.ref('excluded.value') })),
        ),
    );
  }
}
