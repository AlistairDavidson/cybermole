// scheduler.test.mjs — the Scheduler's Result families (src/lib/jobs.ts):
// one case per error code of saveJob / deleteJob / runJob / listJobs (the
// form-shape rules saveJob used to check are JobSaveSchema's now —
// api.test.mjs), and
// the 40-char job-name regression (runs of long names used to be refused by
// tmux's 40-char session-name cap). tmux runs against a private
// ABSOLUTE-path socket set before the import (tmux.ts binds SOCKET at module
// load), so nothing here can touch a real web-pi socket — and with no
// server behind it, opening a run fails with the never-fork guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-sched-test-'));
process.env.WEB_PI_TMUX_SOCKET = path.join(dir, 'tmux');
const SOCKET = process.env.WEB_PI_TMUX_SOCKET;

const { Scheduler } = await import('../../dist-server/src/lib/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/db.js');
const { JobSaveSchema } = await import('../../dist-server/src/schemas/jobs.js');

/** saveJob takes what POST /api/jobs parsed with JobSaveSchema. */
const parsed = (input) => JobSaveSchema.parse(input);

const haveTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function freshScheduler() {
  const db = new StateDb(path.join(fs.mkdtempSync(path.join(dir, 'db-')), 'webpi.db'));
  return new Scheduler(db, { cwd: dir, env: {} });
}

/** A Scheduler whose state db can never open (its parent is a file). */
function brokenScheduler() {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'broken-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new Scheduler(new StateDb(path.join(file, 'webpi.db')), { cwd: dir, env: {} });
}

const GOOD = { name: 'nightly', schedule: '*/5 * * * *', command: 'true' };

test('saveJob: a parsed save succeeds with the normalized name', async () => {
  const s = freshScheduler();
  assert.deepEqual(await s.saveJob(parsed({ ...GOOD, name: '  Nightly Check ' })),
    { ok: true, resultType: 'save_job', data: { name: 'nightly-check' } });
});

test('saveJob: invalid_schedule (not 5-field cron), database_error', async () => {
  const s = freshScheduler();
  for (const schedule of ['daily 08:00', '99 * * * *', '*/5 * * *']) {
    const r = await s.saveJob(parsed({ ...GOOD, schedule }));
    assert.equal(r.errorCode, 'invalid_schedule', schedule);
    assert.ok(r.errorMessage.length > 0);
  }
  const failed = await brokenScheduler().saveJob(parsed(GOOD));
  assert.equal(failed.errorCode, 'database_error');
  assert.match(failed.errorMessage, /^could not save job: /);
});

test('deleteJob: success, job_not_found, database_error', async () => {
  const s = freshScheduler();
  await s.saveJob(parsed(GOOD));
  assert.deepEqual(await s.deleteJob('nightly'), { ok: true, resultType: 'delete_job', data: { name: 'nightly' } });
  const gone = await s.deleteJob('nightly');
  assert.equal(gone.errorCode, 'job_not_found');
  assert.equal(gone.errorMessage, 'no such job');
  assert.equal((await brokenScheduler().deleteJob('nightly')).errorCode, 'database_error');
});

test('listJobs: the jobs state on success, database_error when the db is gone', async () => {
  const s = freshScheduler();
  await s.saveJob(parsed(GOOD));
  const listed = await s.listJobs();
  assert.equal(listed.ok, true);
  assert.equal(listed.data.available, true);
  assert.deepEqual(listed.data.jobs.map(j => [j.name, j.session, j.running]), [['nightly', 'webpi-nightly', false]]);
  const failed = await brokenScheduler().listJobs();
  assert.equal(failed.errorCode, 'database_error');
});

test('runJob: job_not_found; tmux_error (no server behind the socket) still spends the fire', async () => {
  const s = freshScheduler();
  const missing = await s.runJob('nope');
  assert.equal(missing.errorCode, 'job_not_found');
  assert.deepEqual(missing.data, { name: 'nope', session: 'webpi-nope' });

  await s.saveJob(parsed(GOOD));
  const refused = await s.runJob('nightly');
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, 'tmux_error');
  assert.match(refused.errorMessage, /workspace tmux server not running/);
  assert.equal(fs.existsSync(SOCKET), false, 'the never-fork guard must not start a server');
  // Recorded first: a failed spawn still counts as the fire.
  const listed = await s.listJobs();
  assert.ok(listed.data.jobs[0].last, 'the failed run was recorded');
});

test('runJob: database_error when the job cannot be read, or its fire cannot be recorded', async () => {
  const unread = await brokenScheduler().runJob('nightly');
  assert.equal(unread.errorCode, 'database_error');
  assert.match(unread.errorMessage, /^could not read job: /);

  // Reads work, the run bookkeeping write doesn't: the fire is refused
  // before any spawn (a tmux attempt would answer tmux_error instead).
  const db = new StateDb(path.join(fs.mkdtempSync(path.join(dir, 'db-')), 'webpi.db'));
  const s = new Scheduler(db, { cwd: dir, env: {} });
  await s.saveJob(GOOD);
  db.db().prepare('DROP TABLE job_runs').run();
  const unrecorded = await s.runJob('nightly');
  assert.equal(unrecorded.errorCode, 'database_error');
  assert.match(unrecorded.errorMessage, /^could not record the run: /);
  assert.deepEqual(unrecorded.data, { name: 'nightly', session: 'webpi-nightly' });
});

test('runJob: opens the run, then run_active while it lives; 40-char names run too', { skip: !haveTmux }, async () => {
  const conf = path.join(dir, 'server.conf');
  fs.writeFileSync(conf, 'set -g exit-empty off\n');
  execFileSync('tmux', ['-S', SOCKET, '-f', conf, 'start-server']);
  try {
    const s = freshScheduler();
    await s.saveJob(parsed({ ...GOOD, command: 'sleep 10' }));
    assert.deepEqual(await s.runJob('nightly'),
      { ok: true, resultType: 'run_job', data: { name: 'nightly', session: 'webpi-nightly' } });
    const again = await s.runJob('nightly');
    assert.equal(again.errorCode, 'run_active');
    assert.equal(again.data.session, 'webpi-nightly');

    const long = 'x'.repeat(40);
    await s.saveJob(parsed({ ...GOOD, name: long, command: 'sleep 10' }));
    const ran = await s.runJob(long);
    assert.equal(ran.ok, true, ran.errorMessage);
    assert.equal((await s.listJobs()).data.jobs.find(j => j.name === long).running, true);
  } finally {
    try { execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
