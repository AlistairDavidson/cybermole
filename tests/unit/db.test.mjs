// The state db's schema upgrade: a fresh file gets the current shape, a
// v5-shaped file opens as v9 with ALTERs applied and data intact (and the
// old `sessions` table dropped), a newer file refuses, and foreign_keys is
// on. Reopening never re-runs an ALTER.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb, qb } from '../../dist-server/src/lib/platform/db.js';

const MISSING = '99999999-9999-4999-8999-999999999999';

function freshFile(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'cybermole.db');
}

const columns = (sdb, table) =>
  sdb
    .db()
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(c => c.name);
const userVersion = file => {
  const raw = new DatabaseSync(file);
  const v = raw.prepare('PRAGMA user_version').get().user_version;
  raw.close();
  return v;
};

/** What a v5 db looks like: jobs without app_id, job_runs without the run-log columns. */
const V5_SCHEMA = `
  CREATE TABLE IF NOT EXISTS credential (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    username   TEXT    NOT NULL,
    salt       TEXT    NOT NULL,
    hash       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT    PRIMARY KEY,
    hidden_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS jobs (
    name       TEXT    PRIMARY KEY,
    schedule   TEXT    NOT NULL,
    command    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_runs (
    job      TEXT    NOT NULL,
    fired_at INTEGER NOT NULL,
    origin   TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs (job, fired_at);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT    PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    cookie_at  INTEGER NOT NULL
  );
`;

test('a fresh file (user_version 0) gets the v9 shape at CREATE — no ALTER ever throws', () => {
  const file = freshFile('cybermole-db-fresh-');
  const db = new StateDb(file);
  db.db(); // open + migrate
  assert.equal(userVersion(file), 9);
  for (const t of ['apps', 'workspaces', 'terminals']) {
    assert.ok(columns(db, t).length > 0, t);
  }
  assert.ok(columns(db, 'apps').includes('cwd')); // at CREATE
  assert.ok(columns(db, 'apps').includes('icon')); // at CREATE
  assert.ok(columns(db, 'workspaces').includes('kind')); // at CREATE
  assert.ok(columns(db, 'terminals').includes('command')); // at CREATE
  assert.ok(columns(db, 'jobs').includes('app_id'));
  for (const c of ['log', 'exit_code', 'finished_at']) {
    assert.ok(columns(db, 'job_runs').includes(c), c);
  }
  // the old sessions table is never created
  assert.ok(
    db
      .db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .get() == null,
  );
  // Reopening skips every ALTER (ADD COLUMN twice would throw); the DROP
  // re-runs harmlessly.
  const reopened = new StateDb(file);
  reopened.db();
  assert.equal(userVersion(file), 9);
});

test('a v5-shaped file upgrades to v9 with the ALTERs applied and its data intact', () => {
  const file = freshFile('cybermole-db-v5-');
  const raw = new DatabaseSync(file);
  raw.exec(V5_SCHEMA);
  raw.exec('PRAGMA user_version = 5');
  raw
    .prepare(
      "INSERT INTO jobs (name, schedule, command, created_at) VALUES ('nightly', '* * * * *', 'true', 123)",
    )
    .run();
  raw
    .prepare("INSERT INTO job_runs (job, fired_at, origin) VALUES ('nightly', 456, 'schedule')")
    .run();
  raw.prepare("INSERT INTO settings (key, value) VALUES ('k', '\"v\"')").run();
  raw.close();

  const db = new StateDb(file);
  db.db();
  assert.equal(userVersion(file), 9);
  assert.ok(columns(db, 'jobs').includes('app_id'));
  for (const c of ['log', 'exit_code', 'finished_at']) {
    assert.ok(columns(db, 'job_runs').includes(c), c);
  }
  // v5 data survived and the new columns read NULL (spread: null-prototype rows)
  assert.deepEqual(
    {
      ...db.get(
        qb
          .selectFrom('jobs')
          .select(['name', 'schedule', 'command', 'created_at', 'app_id'])
          .where('name', '=', 'nightly'),
      ),
    },
    { name: 'nightly', schedule: '* * * * *', command: 'true', created_at: 123, app_id: null },
  );
  assert.deepEqual(
    {
      ...db.get(
        qb
          .selectFrom('job_runs')
          .select(['job', 'fired_at', 'origin', 'log', 'exit_code', 'finished_at']),
      ),
    },
    {
      job: 'nightly',
      fired_at: 456,
      origin: 'schedule',
      log: null,
      exit_code: null,
      finished_at: null,
    },
  );
  assert.equal(db.getSetting('k'), '"v"');
  // sessions is dropped at every open, and user_version stays 9.
  const tableExists = name =>
    db.db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !=
    null;
  assert.equal(tableExists('sessions'), false);
  assert.equal(userVersion(file), 9);
  new StateDb(file).db(); // reopen: the DROP is idempotent
  assert.equal(tableExists('sessions'), false);
  // the upgraded file takes rows in the new tables (FKs resolve)
  db.run(
    qb.insertInto('apps').values({
      id: '123e4567-e89b-42d3-a456-426614174000',
      name: 'a',
      slug: 'a',
      sort_order: 10,
      created_at: 1,
      updated_at: 1,
      created_by: 't',
      updated_by: 't',
    }),
  );
  db.run(
    qb.insertInto('workspaces').values({
      id: '123e4567-e89b-42d3-a456-426614174001',
      app_id: '123e4567-e89b-42d3-a456-426614174000',
      name: 'w',
      cwd: '/',
      sort_order: 10,
      created_at: 1,
      updated_at: 1,
      created_by: 't',
      updated_by: 't',
    }),
  );
  assert.ok(db.get(qb.selectFrom('workspaces').select('id')));
});

test('a v6 file whose apps table predates apps.cwd gains the column at open, data intact', () => {
  const file = freshFile('cybermole-db-v6-no-app-cwd-');
  // A v6 db from before apps.cwd: apps must exist without cwd so the ALTER adds it.
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
  `);
  raw.exec('PRAGMA user_version = 6');
  raw
    .prepare(
      'INSERT INTO apps (id, name, slug, sort_order, created_at, updated_at, created_by, updated_by) ' +
        "VALUES ('123e4567-e89b-42d3-a456-426614174000', 'alpha app', 'alpha-app', 10, 1, 1, 't', 't')",
    )
    .run();
  raw.close();

  const db = new StateDb(file);
  db.db(); // open + migrate: addColumnIfMissing applies the cwd ALTER
  assert.ok(columns(db, 'apps').includes('cwd'));
  // the existing row survived; the new column reads NULL
  assert.deepEqual(
    {
      ...db.get(
        qb.selectFrom('apps').select(['name', 'slug', 'cwd']).where('slug', '=', 'alpha-app'),
      ),
    },
    { name: 'alpha app', slug: 'alpha-app', cwd: null },
  );
  // the column comes from the check, not the number; the open does bump
  // the file to the current v9
  assert.equal(userVersion(file), 9);
  // reopening skips the ALTER
  const reopened = new StateDb(file);
  reopened.db();
  assert.ok(columns(reopened, 'apps').includes('cwd'));
  assert.equal(userVersion(file), 9);
});

test('a v6 file whose workspaces table predates workspaces.kind gains the column at open, data intact', () => {
  const file = freshFile('cybermole-db-v6-no-ws-kind-');
  // A v6 db from before workspaces.kind: the table must exist without it.
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      app_id     TEXT REFERENCES apps(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
  `);
  raw.exec('PRAGMA user_version = 6');
  raw
    .prepare(
      'INSERT INTO workspaces (id, app_id, name, cwd, sort_order, created_at, updated_at, created_by, updated_by) ' +
        "VALUES ('123e4567-e89b-42d3-a456-426614174001', NULL, 'legacy', '/tmp', 10, 1, 1, 't', 't')",
    )
    .run();
  raw.close();

  const db = new StateDb(file);
  db.db(); // open + migrate: addColumnIfMissing applies the kind ALTER
  assert.ok(columns(db, 'workspaces').includes('kind'));
  // the existing row survived; the new column reads NULL (legacy = console/in-tree)
  assert.deepEqual(
    {
      ...db.get(
        qb
          .selectFrom('workspaces')
          .select(['name', 'kind'])
          .where('id', '=', '123e4567-e89b-42d3-a456-426614174001'),
      ),
    },
    { name: 'legacy', kind: null },
  );
  // the column comes from the check, not the number; the open does bump
  // the file to the current v9
  assert.equal(userVersion(file), 9);
  // reopening skips the ALTER
  const reopened = new StateDb(file);
  reopened.db();
  assert.ok(columns(reopened, 'workspaces').includes('kind'));
  assert.equal(userVersion(file), 9);
});

test('a v6 file whose terminals table predates terminals.command gains the column at open, data intact', () => {
  const file = freshFile('cybermole-db-v6-no-term-command-');
  // A v6 db from before terminals.command: one auto-opened agent tab whose
  // created_at equals the workspace's (the legacy agent-slot marker).
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      cwd        TEXT,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      app_id     TEXT REFERENCES apps(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      kind       TEXT,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS terminals (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title        TEXT,
      sort_order   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      created_by   TEXT NOT NULL,
      updated_by   TEXT NOT NULL
    );
  `);
  raw.exec('PRAGMA user_version = 6');
  raw
    .prepare(
      'INSERT INTO workspaces (id, app_id, name, cwd, kind, sort_order, created_at, updated_at, created_by, updated_by) ' +
        "VALUES ('123e4567-e89b-42d3-a456-426614174001', NULL, 'legacy', '/tmp', NULL, 10, 500, 500, 't', 't')",
    )
    .run();
  raw
    .prepare(
      'INSERT INTO terminals (id, workspace_id, title, sort_order, created_at, updated_at, created_by, updated_by) ' +
        "VALUES ('123e4567-e89b-42d3-a456-426614174011', '123e4567-e89b-42d3-a456-426614174001', NULL, 10, 500, 500, 't', 't')",
    )
    .run();
  raw.close();

  const db = new StateDb(file);
  db.db(); // open + migrate: addColumnIfMissing applies the command ALTER
  assert.ok(columns(db, 'terminals').includes('command'));
  // the row survived; the new column reads NULL (pre-v7: derive from created_at)
  assert.deepEqual(
    {
      ...db.get(qb.selectFrom('terminals').select(['id', 'command']).where('title', 'is', null)),
    },
    { id: '123e4567-e89b-42d3-a456-426614174011', command: null },
  );
  // writes take the column now (the domain always sends it)
  db.run(
    qb.insertInto('terminals').values({
      id: '123e4567-e89b-42d3-a456-426614174012',
      workspace_id: '123e4567-e89b-42d3-a456-426614174001',
      title: null,
      sort_order: 20,
      command: 'shell',
      created_at: 600,
      updated_at: 600,
      created_by: 't',
      updated_by: 't',
    }),
  );
  // reopening skips the ALTER
  const reopened = new StateDb(file);
  reopened.db();
  assert.ok(columns(reopened, 'terminals').includes('command'));
});

test('a v7 file whose apps table predates apps.icon gains the column at open, data intact', () => {
  const file = freshFile('cybermole-db-v7-no-app-icon-');
  // A v7 db from before apps.icon: the apps table without the column.
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      cwd        TEXT,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
  `);
  raw.exec('PRAGMA user_version = 7');
  raw
    .prepare(
      'INSERT INTO apps (id, name, slug, cwd, sort_order, created_at, updated_at, created_by, updated_by) ' +
        "VALUES ('123e4567-e89b-42d3-a456-426614174000', 'alpha app', 'alpha-app', NULL, 10, 1, 1, 't', 't')",
    )
    .run();
  raw.close();

  const db = new StateDb(file);
  db.db(); // open + migrate: addColumnIfMissing applies the icon ALTER
  assert.ok(columns(db, 'apps').includes('icon'));
  // the row survived; the new column reads NULL (the default icon)
  assert.deepEqual(
    {
      ...db.get(
        qb.selectFrom('apps').select(['name', 'slug', 'icon']).where('slug', '=', 'alpha-app'),
      ),
    },
    { name: 'alpha app', slug: 'alpha-app', icon: null },
  );
  // writes take the column now (the domain always sends one)
  db.run(qb.updateTable('apps').set({ icon: 'robot' }).where('slug', '=', 'alpha-app'));
  assert.equal(db.get(qb.selectFrom('apps').select('icon')).icon, 'robot');
  // reopening skips the ALTER
  const reopened = new StateDb(file);
  reopened.db();
  assert.ok(columns(reopened, 'apps').includes('icon'));
});

test('v9 folds each group and kind into its first workspace: terminals move (in order, legacy commands pinned), extras go, the index holds', () => {
  const file = freshFile('cybermole-db-v9-merge-');
  new StateDb(file).db();
  // Back to a v8 world: no index, two console workspaces and two app ones.
  const raw = new DatabaseSync(file);
  raw.exec('DROP INDEX workspaces_one_per_app');
  raw.exec('PRAGMA user_version = 8');
  raw
    .prepare(
      'INSERT INTO apps (id, name, slug, sort_order, created_at, updated_at, created_by, updated_by) ' +
        "VALUES ('a0000000-0000-4000-8000-000000000001', 'A', 'a', 10, 1, 1, 't', 't')",
    )
    .run();
  const ws = raw.prepare(
    'INSERT INTO workspaces (id, app_id, name, cwd, kind, sort_order, created_at, updated_at, created_by, updated_by) ' +
      "VALUES (?, ?, ?, '/tmp', ?, ?, ?, 1, 't', 't')",
  );
  const C1 = 'c0000000-0000-4000-8000-000000000001';
  const C2 = 'c0000000-0000-4000-8000-000000000002';
  const A1 = 'c0000000-0000-4000-8000-000000000003';
  const A2 = 'c0000000-0000-4000-8000-000000000004';
  const A3 = 'c0000000-0000-4000-8000-000000000005';
  ws.run(C2, null, 'second', null, 20, 50);
  ws.run(C1, null, 'first', null, 10, 40);
  ws.run(A1, 'a0000000-0000-4000-8000-000000000001', 'app one', 'build', 10, 60);
  ws.run(A2, 'a0000000-0000-4000-8000-000000000001', 'app two', 'build', 20, 70);
  // the app's operator workspace is another kind: it stays
  ws.run(A3, 'a0000000-0000-4000-8000-000000000001', 'operator', null, 30, 80);
  const term = raw.prepare(
    'INSERT INTO terminals (id, workspace_id, sort_order, command, created_at, updated_at, created_by, updated_by) ' +
      "VALUES (?, ?, ?, ?, ?, 1, 't', 't')",
  );
  term.run('d0000000-0000-4000-8000-000000000001', C1, 10, 'agent', 40);
  term.run('d0000000-0000-4000-8000-000000000002', C1, 20, 'shell', 41);
  // C2's legacy rows: the one born with its workspace is the agent slot.
  term.run('d0000000-0000-4000-8000-000000000003', C2, 10, null, 50);
  term.run('d0000000-0000-4000-8000-000000000004', C2, 20, null, 51);
  term.run('d0000000-0000-4000-8000-000000000005', A2, 10, 'agent', 70);
  term.run('d0000000-0000-4000-8000-000000000006', A3, 10, 'agent', 80);
  raw.close();

  const db = new StateDb(file);
  db.db();
  assert.equal(userVersion(file), 9);
  const rows = db.db().prepare('SELECT id FROM workspaces ORDER BY id').all();
  assert.deepEqual(
    rows.map(r => r.id),
    [C1, A1, A3],
  );
  const terms = db
    .db()
    .prepare('SELECT id, workspace_id, command FROM terminals ORDER BY workspace_id, sort_order')
    .all()
    .map(r => [r.id.slice(-1), r.workspace_id, r.command]);
  assert.deepEqual(terms, [
    ['1', C1, 'agent'],
    ['2', C1, 'shell'],
    ['3', C1, 'agent'],
    ['4', C1, 'shell'],
    ['5', A1, 'agent'],
    ['6', A3, 'agent'],
  ]);
  assert.throws(
    () =>
      db
        .db()
        .prepare(
          'INSERT INTO workspaces (id, app_id, name, cwd, sort_order, created_at, updated_at, created_by, updated_by) ' +
            "VALUES ('c0000000-0000-4000-8000-000000000009', NULL, 'dup', '/tmp', 30, 1, 1, 't', 't')",
        )
        .run(),
    /UNIQUE/,
  );
});

test('a db newer than v9 refuses to open', () => {
  const file = freshFile('cybermole-db-v9-');
  const db = new StateDb(file);
  db.db();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 10');
  raw.close();
  assert.throws(() => new StateDb(file).db(), /newer than this build understands/);
});

test('foreign keys are enforced: the pragma is ON, so a dangling parent is rejected', () => {
  const file = freshFile('cybermole-db-fk-');
  const db = new StateDb(file);
  db.db();
  const pragma = db.db().prepare('PRAGMA foreign_keys').get();
  assert.equal(pragma.foreign_keys, 1);
  assert.throws(
    () =>
      db.run(
        qb.insertInto('workspaces').values({
          id: '123e4567-e89b-42d3-a456-426614174002',
          app_id: MISSING,
          name: 'x',
          cwd: '/',
          sort_order: 10,
          created_at: 1,
          updated_at: 1,
          created_by: 't',
          updated_by: 't',
        }),
      ),
    /FOREIGN KEY constraint failed/,
  );
});
