// db.test.mjs — the schema v6 upgrade (src/lib/db.ts, workspaces-plan §2):
// a fresh file (user_version 0) gets the new shape at CREATE; a v5-shaped
// file opens as v6 with the ALTERs applied and its data intact; a newer
// file refuses; and the foreign_keys pragma the cascade story rests on is
// actually ON. Reopening never re-runs an ALTER (they are guarded by
// table_info, not the version number).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb, qb } from '../../dist-server/src/lib/db.js';

const MISSING = '99999999-9999-4999-8999-999999999999';

function freshFile(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'webpi.db');
}

const columns = (sdb, table) => sdb.db().prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
const userVersion = (file) => {
  const raw = new DatabaseSync(file);
  const v = raw.prepare('PRAGMA user_version').get().user_version;
  raw.close();
  return v;
};

/** The pre-v6 SCHEMA, verbatim shape: jobs without app_id, job_runs
 *  without the run-log columns — what a v5 db on disk looks like. */
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
  CREATE TABLE IF NOT EXISTS releases (
    sha          TEXT    PRIMARY KEY,
    status       TEXT    NOT NULL,
    requested_at INTEGER NOT NULL,
    built_at     INTEGER,
    applied_at   INTEGER,
    log          TEXT
  );
`;

test('a fresh file (user_version 0) gets the v6 shape at CREATE — no ALTER ever throws', () => {
  const file = freshFile('webpi-db-fresh-');
  const db = new StateDb(file);
  db.db(); // open + migrate
  assert.equal(userVersion(file), 6);
  for (const t of ['apps', 'workspaces', 'terminals']) {
    assert.ok(columns(db, t).length > 0, t);
  }
  assert.ok(columns(db, 'jobs').includes('app_id'));
  for (const c of ['log', 'exit_code', 'finished_at']) {
    assert.ok(columns(db, 'job_runs').includes(c), c);
  }
  // reopening runs the same guards and skips every ALTER (ADD COLUMN twice
  // would throw "duplicate column name")
  const reopened = new StateDb(file);
  reopened.db();
  assert.equal(userVersion(file), 6);
});

test('a v5-shaped file upgrades to v6 with the ALTERs applied and its data intact', () => {
  const file = freshFile('webpi-db-v5-');
  const raw = new DatabaseSync(file);
  raw.exec(V5_SCHEMA);
  raw.exec('PRAGMA user_version = 5');
  raw.prepare("INSERT INTO jobs (name, schedule, command, created_at) VALUES ('nightly', '* * * * *', 'true', 123)")
    .run();
  raw.prepare("INSERT INTO job_runs (job, fired_at, origin) VALUES ('nightly', 456, 'schedule')").run();
  raw.prepare("INSERT INTO sessions (session_id, hidden_at) VALUES ('019f4706-0000-7000-8000-00000000000a', 789)")
    .run();
  raw.prepare("INSERT INTO settings (key, value) VALUES ('k', '\"v\"')").run();
  raw.close();

  const db = new StateDb(file);
  db.db();
  assert.equal(userVersion(file), 6);
  // the ALTERs landed
  assert.ok(columns(db, 'jobs').includes('app_id'));
  for (const c of ['log', 'exit_code', 'finished_at']) {
    assert.ok(columns(db, 'job_runs').includes(c), c);
  }
  // the v5 data survived, and the new columns read as NULL (spread: node:sqlite
  // rows carry a null prototype, which deepEqual treats as a different object)
  assert.deepEqual(
    { ...db.get(qb.selectFrom('jobs').select(['name', 'schedule', 'command', 'created_at', 'app_id']).where('name', '=', 'nightly')) },
    { name: 'nightly', schedule: '* * * * *', command: 'true', created_at: 123, app_id: null });
  assert.deepEqual(
    { ...db.get(qb.selectFrom('job_runs').select(['job', 'fired_at', 'origin', 'log', 'exit_code', 'finished_at'])) },
    { job: 'nightly', fired_at: 456, origin: 'schedule', log: null, exit_code: null, finished_at: null });
  assert.deepEqual([...new Set(db.all(qb.selectFrom('sessions').select('session_id')).map(r => r.session_id))],
    ['019f4706-0000-7000-8000-00000000000a']);
  assert.equal(db.getSetting('k'), '"v"');
  // and the upgraded file takes the new tables' rows (FKs resolve)
  db.run(qb.insertInto('apps').values({
    id: '123e4567-e89b-42d3-a456-426614174000', name: 'a', slug: 'a', sort_order: 10,
    created_at: 1, updated_at: 1, created_by: 't', updated_by: 't',
  }));
  db.run(qb.insertInto('workspaces').values({
    id: '123e4567-e89b-42d3-a456-426614174001', app_id: '123e4567-e89b-42d3-a456-426614174000',
    name: 'w', cwd: '/', sort_order: 10, created_at: 1, updated_at: 1, created_by: 't', updated_by: 't',
  }));
  assert.ok(db.get(qb.selectFrom('workspaces').select('id')));
});

test('a db newer than v6 refuses to open', () => {
  const file = freshFile('webpi-db-v7-');
  const db = new StateDb(file);
  db.db();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 7');
  raw.close();
  assert.throws(() => new StateDb(file).db(), /newer than this build understands/);
});

test('foreign keys are enforced: the pragma is ON, so a dangling parent is rejected', () => {
  const file = freshFile('webpi-db-fk-');
  const db = new StateDb(file);
  db.db();
  const pragma = db.db().prepare('PRAGMA foreign_keys').get();
  assert.equal(pragma.foreign_keys, 1);
  assert.throws(() => db.run(qb.insertInto('workspaces').values({
    id: '123e4567-e89b-42d3-a456-426614174002', app_id: MISSING, name: 'x', cwd: '/',
    sort_order: 10, created_at: 1, updated_at: 1, created_by: 't', updated_by: 't',
  })), /FOREIGN KEY constraint failed/);
});
