// app-kit-db.test.mjs — the kit's generic node:sqlite helper
// (packages/app-kit/src/db/sqlite.ts, extracted from src/lib/db.ts by
// task/app-kit): a fresh file gets schema+version at open, migrate runs
// every open (idempotently), a newer file refuses with the caller's label,
// freshMode lands on the file, FKs are on, and the createQb/SqliteDb pair
// round-trips rows through the databaseRead/databaseUpdate boundary. The
// cybermole-state half of the split stays covered by db.test.mjs (the v6
// upgrade story, unchanged paths).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SqliteDb,
  createQb,
  databaseRead,
  databaseUpdate,
} from '../../dist-server/packages/app-kit/src/db/sqlite.js';

// untyped in plain JS — the compiled kit's own types carry the generics
const qb = createQb();

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id   INTEGER PRIMARY KEY,
    body TEXT NOT NULL
  );
`;

function freshFile(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'app.db');
}

const userVersion = file => {
  const raw = new DatabaseSync(file);
  const v = raw.prepare('PRAGMA user_version').get().user_version;
  raw.close();
  return v;
};

test('a fresh file: schema + version at open, migrate runs, freshMode lands', () => {
  const file = freshFile('kit-db-fresh-');
  let migrations = 0;
  const db = new SqliteDb(file, {
    schema: SCHEMA,
    migrate: () => {
      migrations++;
    },
    version: 3,
    freshMode: 0o600,
    label: 'test db',
  });
  db.db();
  assert.equal(userVersion(file), 3);
  assert.equal(migrations, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // foreign_keys is ON (never a Node default to rely on)
  assert.equal(db.db().prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  // reopen: idempotent — migrate again, no version move, no throw
  new SqliteDb(file, { schema: SCHEMA, migrate: () => migrations++, version: 3 }).db();
  assert.equal(migrations, 2);
  assert.equal(userVersion(file), 3);
});

test('a newer file refuses to open, with the caller label in the message', () => {
  const file = freshFile('kit-db-newer-');
  new SqliteDb(file, { schema: SCHEMA, version: 2 }).db();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 9');
  raw.close();
  assert.throws(
    () => new SqliteDb(file, { schema: SCHEMA, version: 2, label: 'app db' }).db(),
    /app db .* is schema v9 — newer than this build understands/,
  );
  // and without a label the generic subject
  assert.throws(
    () => new SqliteDb(file, { schema: SCHEMA, version: 2 }).db(),
    /database .* is schema v9/,
  );
});

test('createQb + SqliteDb: typed round-trip through the boundary Results', async () => {
  const file = freshFile('kit-db-roundtrip-');
  const db = new SqliteDb(file, { schema: SCHEMA, version: 1 });

  const written = databaseUpdate('could not save the note', () =>
    db.run(qb.insertInto('notes').values({ id: 1, body: 'first' })),
  );
  assert.equal(written.ok, true);
  assert.deepEqual(written.data, { changes: 1 });

  const read = databaseRead('could not list the notes', () =>
    db.all(qb.selectFrom('notes').select(['id', 'body'])),
  );
  assert.equal(read.ok, true);
  // node:sqlite rows carry a null prototype; spread each for deepEqual
  assert.deepEqual(
    read.data.value.map(r => ({ ...r })),
    [{ id: 1, body: 'first' }],
  );

  // the boundary catches a sqlite error as database_error (a bad column)
  const failed = databaseRead('could not read', () =>
    db.all(qb.selectFrom('notes').select('nope')),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'database_error');
  assert.match(failed.errorMessage, /could not read: /);
});

// The replaced-file latch (task/app-web): the app host's boot discovery
// legitimately opens the state db at server boot — before the e2e
// global-setup resets the workspace — so the connection can latch onto a
// file the reset then replaces. SqliteDb adopts the new file by inode at
// the next query; a file merely deleted (no replacement) keeps serving
// the open inode instead of silently adopting a fresh empty one.
test('a replaced db file is adopted at the next query; a deleted one is not', async () => {
  const file = freshFile('kit-db-replaced-');
  const db = new SqliteDb(file, { schema: SCHEMA, version: 1 });
  // Prime BOTH halves of the cache: the connection and a prepared statement.
  db.run(qb.insertInto('notes').values({ id: 1, body: 'original' }));
  assert.equal(db.get(qb.selectFrom('notes').select('body').where('id', '=', 1))?.body, 'original');

  // The reset: a second file is built elsewhere and swapped in (like the
  // e2e's workspace reset) with a row the old file never had.
  const swap = path.join(path.dirname(file), 'swap.db');
  const seeder = new SqliteDb(swap, { schema: SCHEMA, version: 1 });
  seeder.run(qb.insertInto('notes').values({ id: 1, body: 'replacement' }));
  fs.rmSync(file);
  fs.copyFileSync(swap, file);

  // The next query sees the NEW file — the old inode would read 'original'
  // and fail every write readonly — and writes land on it.
  assert.equal(
    db.get(qb.selectFrom('notes').select('body').where('id', '=', 1))?.body,
    'replacement',
  );
  const wrote = databaseUpdate('could not save the note', () =>
    db.run(qb.insertInto('notes').values({ id: 2, body: 'second' })),
  );
  assert.equal(wrote.ok, true);
  assert.equal(db.all(qb.selectFrom('notes').select('id')).length, 2);

  // A deleted file (no replacement): the open connection keeps serving —
  // reads still answer from the inode it holds; nothing resets to a fresh
  // empty db behind the caller's back.
  fs.rmSync(file);
  assert.equal(db.get(qb.selectFrom('notes').select('body').where('id', '=', 2))?.body, 'second');
});

test('createQb only compiles: a query run through Kysely itself throws, never silently reads', async () => {
  const file = freshFile('kit-db-compile-only-');
  new SqliteDb(file, { schema: SCHEMA, version: 1 }).db();
  await assert.rejects(() => qb.selectFrom('notes').selectAll().execute(), /only compiles queries/);
});
