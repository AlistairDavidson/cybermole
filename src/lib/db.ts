// db.ts — cybermole's persisted state: one SQLite file (node:sqlite).
//
// Everything the app itself writes lives in ENV.CYBERMOLE_DB_FILE (default
// <state dir>/cybermole.db): the login credential (single row), the login
// sessions (`auth_sessions` — token hashes only, src/lib/auth.ts), the
// apps/workspaces/terminals tables (docs/workspaces-plan.md §2 —
// src/lib/apps.ts, src/lib/workspaces.ts; the pi-session `sessions`
// overlay died with the scan that read it, plan §11),
// the scheduled-jobs tables (`jobs` definitions,
// `job_runs` bookkeeping — src/lib/jobs.ts) and a small `settings` kv
// (src/lib/auto-update.ts). pi's own store (sessions/,
// provider creds under CYBERMOLE_AGENT_DIR) is not cybermole state and stays
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
// task/app-kit (docs/apps-plan.md §5): the generic half of this file —
// the lazily-opened connection with cached statements (SqliteDb), the
// compile-only query-builder factory (createQb) and the
// databaseRead/databaseUpdate boundary Results — moved to
// @cybermole/app-kit's db/sqlite.ts; this file keeps cybermole's schema,
// migrations and settings accessors and imports the generic pieces from
// the kit. databaseRead/databaseUpdate/etc. are imported from the kit
// directly everywhere else too.
//
// NB: node:sqlite still prints a one-line ExperimentalWarning when it
// first loads (server boot, set-password, e2e output). Expected — see
// AGENTS.md.
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
  -- The pi-session overlay table is GONE (workspaces-plan §11, dropped
  -- together with the code that read it in task/ws-console): idempotent,
  -- runs at every open — no version bookkeeping, user_version stays 6.
  DROP TABLE IF EXISTS sessions;
  -- Apps / workspaces / terminals (docs/workspaces-plan.md §2, schema v6):
  -- apps 1—M workspaces 1—M terminals, console = the NULL app. ids are
  -- uuid v4 minted by the server; sort_order is explicit (steps of 10),
  -- ordering never relies on the id; created_by/updated_by carry the
  -- single credential row's username. Cascades do the structural deletes
  -- (an app takes its workspaces and their terminals with it); jobs are
  -- only ever TAGGED with an app (SET NULL below), never owned by one.
  CREATE TABLE IF NOT EXISTS apps (
    id         TEXT PRIMARY KEY,     -- uuid v4 (crypto.randomUUID) → AppId
    name       TEXT NOT NULL,        -- display name, free text
    slug       TEXT NOT NULL UNIQUE, -- APP_SLUG_RE (the kit's schemas/patterns.ts)
    cwd        TEXT,                 -- optional: where workspaces under this app start (NULL = the server default, task/app-cwd)
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
  -- Scheduled-job definitions for the in-process scheduler
  -- (src/lib/jobs.ts). command is an arbitrary shell string BY DESIGN
  -- (typed by the authenticated user) — it only ever reaches tmux as
  -- tmux's own command string, never a server-side shell.
  CREATE TABLE IF NOT EXISTS jobs (
    name       TEXT    PRIMARY KEY,  -- JOB_NAME_RE (the kit's schemas/patterns.ts)
    schedule   TEXT    NOT NULL,     -- 5-field cron
    command    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,     -- epoch ms; catch-up reference until the first fire
    app_id     TEXT    REFERENCES apps(id) ON DELETE SET NULL  -- optional tag, never ownership (plan §9)
  );
  -- One row per fired run (scheduler tick, boot catch-up, or "run now").
  -- MAX(fired_at) per job is its last-fired: what boot catch-up compares
  -- against the schedule (systemd Persistent=true equivalent).
  CREATE TABLE IF NOT EXISTS job_runs (
    job         TEXT    NOT NULL,
    fired_at    INTEGER NOT NULL,       -- epoch ms the run's tmux session opened
    origin      TEXT    NOT NULL,       -- 'schedule' | 'catchup' | 'manual'
    log         TEXT,                   -- log file path, NULL pre-v6 runs (plan §9)
    exit_code   INTEGER,                -- filled when the finish is observed
    finished_at INTEGER                 -- ditto
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
// Branded columns: the state db is a trusted source (the kit's types/
// branded.ts) — ids are validated before they're written, so rows read
// back branded.

/** How a job run was fired (job_runs.origin). */
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
  /** Optional: where workspaces under this app start — the create-side
   *  default derivation (task/app-cwd). NULL = the configured default. */
  cwd: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  updated_by: string;
}
export interface WorkspacesTable {
  id: WorkspaceId;
  /** NULL = the console (not an app row — plan §1). */
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
  /** NULL → the UI labels the tab "term N". */
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
  /** Optional app tag — never ownership (plan §9). */
  app_id: AppId | null;
}
export interface JobRunsTable {
  job: JobName;
  fired_at: number;
  origin: JobRunOrigin;
  /** Log file path (NULL pre-v6 runs), exit + finish filled when the
   *  finish is observed (plan §9). */
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

/** The typed query builder for the state db (compile-only; see the module
 *  comment — the kit's createQb). Stateless — safe to share across StateDb
 *  instances. */
export const qb = createQb<StateSchema>();

/** Add a column to an existing table unless it is already there. ALTER
 *  TABLE ADD COLUMN is NOT idempotent (a second run fails with `duplicate
 *  column name`), so every v6 ALTER is guarded by a PRAGMA table_info
 *  column check — NOT by the version number: a fresh db (user_version 0)
 *  gets the new columns in SCHEMA's CREATE above and must then skip the
 *  ALTER, while a pre-v6 db passes create-then-alter. Table/column names
 *  are module constants, never user input. */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/** The v6 migration: jobs gains its optional app tag, job_runs the
 *  persisted-run columns (docs/workspaces-plan.md §2), and apps its
 *  optional cwd (task/app-cwd — the workspace-create default derivation).
 *  Additive only —
 * the `sessions` table stays untouched in this branch (it dies, with its
 * readers, in task/ws-console). Runs at every open; each ALTER is guarded
 *  by addColumnIfMissing, so a fresh db (columns already in CREATE), a
 *  pre-v6 db and a v6 db from before task/app-cwd all pass — the column
 *  check decides, never the version number. */
function migrateToV6(db: DatabaseSync): void {
  addColumnIfMissing(db, 'jobs', 'app_id', 'TEXT REFERENCES apps(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'job_runs', 'log', 'TEXT');
  addColumnIfMissing(db, 'job_runs', 'exit_code', 'INTEGER');
  addColumnIfMissing(db, 'job_runs', 'finished_at', 'INTEGER');
  addColumnIfMissing(db, 'apps', 'cwd', 'TEXT');
}

/** cybermole's state database: the kit's SqliteDb under the state schema
 * (lazily-opened connection, cached statements — see the module comment),
 * plus the settings kv accessors. */
export class StateDb extends SqliteDb {
  constructor(file: string) {
    super(file, {
      schema: SCHEMA,
      migrate: migrateToV6,
      // user_version: 1 = credential + sessions; 2 adds the job tables;
      // 3 adds the settings kv table; 4 adds auth_sessions; 5 added the
      // releases table (gone again with the management page — a `releases`
      // table left in an old db is an orphan, harmless); 6 adds
      // apps/workspaces/terminals
      // + the jobs/job_runs columns above and drops the pi-session
      // overlay (workspaces plan §2/§11 — the one destructive step,
      // idempotent in SCHEMA itself); apps.cwd rides the same v6 shape
      // (task/app-cwd, additive — a v6 db from before it still opens: the
      // column check applies it, the version never moves). The CREATE IF
      // NOT EXISTS block + migrateToV6 bring any older db up to the
      // current shape.
      version: 6,
      freshMode: 0o600, // it holds the password hash
      label: 'state db',
    });
  }

  /** Read one app-settings value (settings kv table); null when unset. */
  getSetting(key: string): string | null {
    return (
      this.get(qb.selectFrom('settings').select('value').where('key', '=', key))?.value ?? null
    );
  }

  /** Write one app-settings value. Throws on db failure — callers wrap it
   *  in databaseUpdate() so failure reaches the user as a Result (the API
   *  500s instead of lying). */
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
