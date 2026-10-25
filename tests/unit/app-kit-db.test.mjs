// The kit's sqlite helper: schema and version at open, migrate on every open,
// a newer file refused with the caller's label, freshMode, FKs on, and rows
// round-tripping through the databaseRead/Update boundary. The state db's
// own upgrade story is in db.test.mjs.
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
  // foreign_keys is on (never relying on Node's default)
  assert.equal(db.db().prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  // reopen is idempotent: migrate runs, the version doesn't move
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
  // without a label, the generic subject
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
  // node:sqlite rows have a null prototype; spread for deepEqual
  assert.deepEqual(
    read.data.value.map(r => ({ ...r })),
    [{ id: 1, body: 'first' }],
  );

  // a sqlite error (bad column) becomes database_error
  const failed = databaseRead('could not read', () =>
    db.all(qb.selectFrom('notes').select('nope')),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'database_error');
  assert.match(failed.errorMessage, /could not read: /);
});

// A connection opened before a file is replaced (e2e's workspace reset)
// adopts the new file by inode at the next query; a deleted file with no
// replacement keeps serving the open inode.
test('a replaced db file is adopted at the next query; a deleted one is not', async () => {
  const file = freshFile('kit-db-replaced-');
  const db = new SqliteDb(file, { schema: SCHEMA, version: 1 });
  // Prime both caches: the connection and a prepared statement.
  db.run(qb.insertInto('notes').values({ id: 1, body: 'original' }));
  assert.equal(db.get(qb.selectFrom('notes').select('body').where('id', '=', 1))?.body, 'original');

  // Swap in a file built elsewhere, with a row the old one never had.
  const swap = path.join(path.dirname(file), 'swap.db');
  const seeder = new SqliteDb(swap, { schema: SCHEMA, version: 1 });
  seeder.run(qb.insertInto('notes').values({ id: 1, body: 'replacement' }));
  fs.rmSync(file);
  fs.copyFileSync(swap, file);

  // The next query sees the new file (the old inode would read 'original'
  // and fail writes readonly), and writes land on it.
  assert.equal(
    db.get(qb.selectFrom('notes').select('body').where('id', '=', 1))?.body,
    'replacement',
  );
  const wrote = databaseUpdate('could not save the note', () =>
    db.run(qb.insertInto('notes').values({ id: 2, body: 'second' })),
  );
  assert.equal(wrote.ok, true);
  assert.equal(db.all(qb.selectFrom('notes').select('id')).length, 2);

  // Deleted with no replacement: reads still come from the held inode.
  fs.rmSync(file);
  assert.equal(db.get(qb.selectFrom('notes').select('body').where('id', '=', 2))?.body, 'second');
});

test('createQb only compiles: a query run through Kysely itself throws, never silently reads', async () => {
  const file = freshFile('kit-db-compile-only-');
  new SqliteDb(file, { schema: SCHEMA, version: 1 }).db();
  await assert.rejects(() => qb.selectFrom('notes').selectAll().execute(), /only compiles queries/);
});
