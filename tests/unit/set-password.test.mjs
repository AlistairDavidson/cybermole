// set-password's --if-unset seed mode, as compose's dev service runs it, in
// child processes (env.ts reads CYBERMOLE_* at load). A fresh db seeds
// test/test (under the 8-char minimum, proving the mode skips it); an
// existing credential is untouched (exit 0, silent); the other modes keep
// their checks. stderr carries node:sqlite's ExperimentalWarning, so match
// it with patterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { Auth, setCredential } = await import('../../dist-server/src/lib/platform/auth.js');
const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');

const BIN = path.join('dist-server', 'server', 'set-password.js');
/** compose's literal seed input */
const SEED = 'test\ntest\ntest\n';

/** Bare env plus overrides; returns status/stdout/stderr for any exit. */
function run(argv, input, env = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith('CYBERMOLE_') && !k.startsWith('PI_CODING_AGENT'),
    ),
  );
  const r = spawnSync(process.execPath, [BIN, ...argv], {
    input,
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-setpw-unit-'));
const dbAt = dir => path.join(dir, 'cybermole.db');

test('--if-unset on a fresh db seeds test/test (under the ≥8 minimum, on purpose)', async () => {
  const dir = stateDir();
  const seeded = run(['--if-unset'], SEED, { CYBERMOLE_STATE_DIR: dir });
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.match(seeded.stdout, /^written: /); // it says so, once, in the boot log
  const auth = new Auth(new StateDb(dbAt(dir)));
  assert.equal(auth.configured().data.value, true);
  assert.equal((await auth.verify('test', 'test')).ok, true); // login enforces no length
});

test('--if-unset with an existing credential: exit 0, SILENT, original intact', async () => {
  const dir = stateDir();
  const db = new StateDb(dbAt(dir));
  assert.equal(setCredential(db, 'dev', 'a-real-password').ok, true);

  // The recreate: the seed runs again and must touch nothing.
  const noop = run(['--if-unset'], SEED, { CYBERMOLE_STATE_DIR: dir });
  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(noop.stdout, '', 'silent — nothing re-seeded');
  const auth = new Auth(db);
  assert.equal((await auth.verify('dev', 'a-real-password')).ok, true);
  assert.equal((await auth.verify('test', 'test')).ok, false);
  assert.equal(auth.username().data.value, 'dev');
});

test('--if-unset still validates its machine-fed input (wiring bugs surface)', () => {
  const dir = stateDir();
  const noUser = run(['--if-unset'], '\npw\npw\n', { CYBERMOLE_STATE_DIR: dir });
  assert.equal(noUser.status, 1);
  assert.match(noUser.stderr, /username required/);
  const noPass = run(['--if-unset'], 'test\n\n\n', { CYBERMOLE_STATE_DIR: dir });
  assert.equal(noPass.status, 1);
  assert.match(noPass.stderr, /password required/);
  const mismatch = run(['--if-unset'], 'test\none\ntwo\n', { CYBERMOLE_STATE_DIR: dir });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /passwords do not match/);
  // none of them wrote anything
  assert.equal(new Auth(new StateDb(dbAt(dir))).configured().data.value, false);
});

test('piped mode without the flag is unchanged: still ≥8, still sets', async () => {
  const dir = stateDir();
  const short = run([], 'test\ntest\ntest\n', { CYBERMOLE_STATE_DIR: dir });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /password must be >= 8 chars\n?$/);

  const set = run([], 'dev\ndevdevdev\ndevdevdev\n', { CYBERMOLE_STATE_DIR: dir });
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /^written: /);
  const auth = new Auth(new StateDb(dbAt(dir)));
  assert.equal((await auth.verify('dev', 'devdevdev')).ok, true);
  assert.equal((await auth.verify('test', 'test')).ok, false);
});
