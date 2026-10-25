// set-password.test.mjs — task/dev-credentials units: the set-password
// CLI's --if-unset seed mode, the exact command compose's dev service
// pipes (printf 'test\ntest\ntest\n' | … --if-unset). Child processes,
// not in-process calls (the cli.test.mjs bin pattern): env.ts captures
// CYBERMOLE_* at module load, so each run needs its own CYBERMOLE_STATE_DIR
// — and the assertions cover the compiled artifact compose runs, exit
// codes and stdout/stderr included. The contract under test: a fresh db
// seeds (test/test — 4 chars, deliberately under the ≥8 minimum that
// guards an interactive typo, and the proof the mode skips it); an
// EXISTING credential is sacred — exit 0, silent, original intact — so a
// password set with dev:set-password survives every container recreate;
// and the pre-existing modes keep their checks byte-for-byte.
// stderr also carries node:sqlite's one-line ExperimentalWarning
// (AGENTS.md) — match patterns, never exact-equality, on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { Auth, setCredential } = await import('../../dist-server/src/lib/platform/auth.js');
const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');

const BIN = path.join('dist-server', 'server', 'set-password.js');
/** compose's literal seed input (the dev service's printf). */
const SEED = 'test\ntest\ntest\n';

/** One CLI run with piped stdin and a bare env + overrides (state-dir.spec's
 *  bareEnv idea): returns status/stdout/stderr for ANY exit code. */
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

  // The recreate: the seed runs again (different input, even) and must
  // touch nothing — dev's "changed passwords survive" property.
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
  // Nothing was written by any of them.
  assert.equal(new Auth(new StateDb(dbAt(dir))).configured().data.value, false);
});

test('piped mode without the flag is unchanged: still ≥8, still sets', async () => {
  const dir = stateDir();
  const short = run([], 'test\ntest\ntest\n', { CYBERMOLE_STATE_DIR: dir });
  assert.equal(short.status, 1);
  // stderr also carries node:sqlite's expected ExperimentalWarning — match, don't equal
  assert.match(short.stderr, /password must be >= 8 chars\n?$/);

  const set = run([], 'dev\ndevdevdev\ndevdevdev\n', { CYBERMOLE_STATE_DIR: dir });
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /^written: /);
  const auth = new Auth(new StateDb(dbAt(dir)));
  assert.equal((await auth.verify('dev', 'devdevdev')).ok, true);
  assert.equal((await auth.verify('test', 'test')).ok, false);
});
