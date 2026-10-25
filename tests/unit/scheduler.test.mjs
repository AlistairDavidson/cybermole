// The Scheduler's Result families, one case per error code, long job names,
// and the tick's run-lifecycle logging against a fake tmux. tmux points at a
// private absolute socket set before the import, so nothing here touches a
// real one, and with no server behind it a run fails the never-fork guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-sched-test-'));
process.env.CYBERMOLE_TMUX_SOCKET = path.join(dir, 'tmux');
const SOCKET = process.env.CYBERMOLE_TMUX_SOCKET;

const { Scheduler } = await import('../../dist-server/src/lib/jobs/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');
const { JobSaveSchema } = await import('../../dist-server/src/schemas/jobs.js');

/** What POST /api/jobs parsed with JobSaveSchema. */
const parsed = input => JobSaveSchema.parse(input);

const haveTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function freshScheduler() {
  const db = new StateDb(path.join(fs.mkdtempSync(path.join(dir, 'db-')), 'cybermole.db'));
  return new Scheduler(db, {
    cwd: dir,
    env: {},
    logDir: path.join(dir, 'job-logs'),
    logMaxBytes: 20 * 1024 * 1024,
  });
}

/** Its state db can never open (the parent is a file). */
function brokenScheduler() {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'broken-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new Scheduler(new StateDb(path.join(file, 'cybermole.db')), {
    cwd: dir,
    env: {},
    logDir: path.join(dir, 'job-logs'),
    logMaxBytes: 20 * 1024 * 1024,
  });
}

const GOOD = { name: 'nightly', schedule: '*/5 * * * *', command: 'true' };

test('saveJob: a parsed save succeeds with the normalized name', async () => {
  const s = freshScheduler();
  assert.deepEqual(await s.saveJob(parsed({ ...GOOD, name: '  Nightly Check ' })), {
    ok: true,
    resultType: 'save_job',
    data: { name: 'nightly-check' },
  });
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
  // saveJob reads the row first (created vs updated), so it fails on that read.
  assert.match(failed.errorMessage, /^could not read job: /);
});

test('deleteJob: success, job_not_found, database_error', async () => {
  const s = freshScheduler();
  await s.saveJob(parsed(GOOD));
  assert.deepEqual(await s.deleteJob('nightly'), {
    ok: true,
    resultType: 'delete_job',
    data: { name: 'nightly' },
  });
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
  assert.deepEqual(
    listed.data.jobs.map(j => [j.name, j.session, j.running]),
    [['nightly', 'cybermole-nightly', false]],
  );
  const failed = await brokenScheduler().listJobs();
  assert.equal(failed.errorCode, 'database_error');
});

test('runJob: job_not_found; tmux_error (no server behind the socket) still spends the fire', async () => {
  const s = freshScheduler();
  const missing = await s.runJob('nope');
  assert.equal(missing.errorCode, 'job_not_found');
  assert.deepEqual(missing.data, { name: 'nope', session: 'cybermole-nope' });

  await s.saveJob(parsed(GOOD));
  const refused = await s.runJob('nightly');
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, 'tmux_error');
  assert.match(refused.errorMessage, /workspace tmux server not running/);
  assert.equal(fs.existsSync(SOCKET), false, 'the never-fork guard must not start a server');
  // Recorded first: a failed spawn still spends the fire.
  const listed = await s.listJobs();
  assert.ok(listed.data.jobs[0].last, 'the failed run was recorded');
});

test('runJob: database_error when the job cannot be read, or its fire cannot be recorded', async () => {
  const unread = await brokenScheduler().runJob('nightly');
  assert.equal(unread.errorCode, 'database_error');
  assert.match(unread.errorMessage, /^could not read job: /);

  // Reads work but the run write doesn't: refused before any spawn.
  const db = new StateDb(path.join(fs.mkdtempSync(path.join(dir, 'db-')), 'cybermole.db'));
  const s = new Scheduler(db, {
    cwd: dir,
    env: {},
    logDir: path.join(dir, 'job-logs'),
    logMaxBytes: 20 * 1024 * 1024,
  });
  await s.saveJob(GOOD);
  db.db().prepare('DROP TABLE job_runs').run();
  const unrecorded = await s.runJob('nightly');
  assert.equal(unrecorded.errorCode, 'database_error');
  assert.match(unrecorded.errorMessage, /^could not record the run: /);
  assert.deepEqual(unrecorded.data, { name: 'nightly', session: 'cybermole-nightly' });
});

test(
  'runJob: opens the run, then run_active while it lives; 40-char names run too',
  { skip: !haveTmux },
  async () => {
    const conf = path.join(dir, 'server.conf');
    fs.writeFileSync(conf, 'set -g exit-empty off\n');
    execFileSync('tmux', ['-S', SOCKET, '-f', conf, 'start-server']);
    try {
      const s = freshScheduler();
      await s.saveJob(parsed({ ...GOOD, command: 'sleep 10' }));
      assert.deepEqual(await s.runJob('nightly'), {
        ok: true,
        resultType: 'run_job',
        data: { name: 'nightly', session: 'cybermole-nightly' },
      });
      const again = await s.runJob('nightly');
      assert.equal(again.errorCode, 'run_active');
      assert.equal(again.data.session, 'cybermole-nightly');

      const long = 'x'.repeat(40);
      await s.saveJob(parsed({ ...GOOD, name: long, command: 'sleep 10' }));
      const ran = await s.runJob(long);
      assert.equal(ran.ok, true, ran.errorMessage);
      assert.equal((await s.listJobs()).data.jobs.find(j => j.name === long).running, true);
    } finally {
      try {
        execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' });
      } catch {
        /* gone */
      }
    }
  },
);

// ---------- tick lifecycle, fake tmux, in a child ----------
//
// In a child so its stdout can be captured without fighting node:test's
// protocol. Fake tmux: $FAKE_TMUX_DIR/up marks the server up,
// $FAKE_TMUX_DIR/sessions lists live sessions (new-session appends).

const FAKE_TMUX = `#!/bin/sh
# Stand-in tmux (written by scheduler.test.mjs): up/sessions files in
# $FAKE_TMUX_DIR steer it; speaks the commands src/lib/terminals/tmux.ts issues.
# list-sessions answers the -F format tmux.ts sends; the human default
# format would parse as no sessions.
dir="$FAKE_TMUX_DIR"; sessions="$dir/sessions"
# Created here, not by the test: a missing file would make the read
# redirection below a fatal error in sh and read as a dead server.
[ -e "$sessions" ] || : > "$sessions"
while [ $# -gt 0 ]; do case "$1" in -f|-S|-L) shift 2 ;; *) break ;; esac; done
sub="$1"; shift
case "$sub" in
  list-sessions)
    [ -e "$dir/up" ] || { echo "error connecting to $CYBERMOLE_TMUX_SOCKET (No such file or directory)" >&2; exit 1; }
    fmt=""
    while [ $# -gt 0 ]; do
      [ "$1" = "-F" ] && { fmt="$2"; shift 2; continue; }
      shift
    done
    while IFS= read -r name; do
      # liveSessionNames asks -F '#{session_name}' — one bare name per
      # line; anything fancier falls back to the old pipe-field shape.
      [ "$fmt" = '#{session_name}' ] && echo "$name" || echo "$name|1|0||"
    done < "$sessions"
    ;;
  has-session)
    [ -e "$dir/up" ] || exit 1
    while [ $# -gt 0 ]; do [ "$1" = "-t" ] && { grep -qx "$2" "$sessions" && exit 0; exit 1; }; shift; done
    exit 1
    ;;
  new-session)
    [ -e "$dir/up" ] || { echo "error connecting to $CYBERMOLE_TMUX_SOCKET (No such file or directory)" >&2; exit 1; }
    while [ $# -gt 0 ]; do [ "$1" = "-s" ] && { echo "$2" >> "$sessions"; exit 0; }; shift; done
    exit 1
    ;;
  *) echo "fake-tmux: unsupported subcommand: $sub" >&2; exit 1 ;;
esac
`;

const RUNS_CHILD = `
const fs = require('fs'); const path = require('path');
const dir = process.env.FAKE_TMUX_DIR;
const sessions = path.join(dir, 'sessions');
const { Scheduler } = require(process.cwd() + '/dist-server/src/lib/jobs/jobs.js');
const { StateDb } = require(process.cwd() + '/dist-server/src/lib/platform/db.js');
const { JobSaveSchema } = require(process.cwd() + '/dist-server/src/schemas/jobs.js');
const db = new StateDb(path.join(dir, 'cybermole.db'));
const s = new Scheduler(db, {
  cwd: dir,
  env: {},
  logDir: path.join(dir, 'job-logs'),
  logMaxBytes: 20 * 1024 * 1024,
});
// No process.exit: it can truncate buffered output; exitCode lets it drain.
(async () => {
  const parse = (o) => JobSaveSchema.parse(o);
  const saved = await s.saveJob(parse({ name: 'nightly', schedule: '* * * * *', command: 'true' }));
  if (!saved.ok) { console.log('CHILD-FAIL saveJob: ' + saved.errorMessage); process.exitCode = 1; return; }
  // A fire ten minutes ago: the first tick fires a catch-up (>2 ticks late).
  db.db().prepare('INSERT INTO job_runs (job, fired_at, origin) VALUES (?, ?, ?)')
    .run('nightly', Date.now() - 10 * 60_000, 'schedule');
  fs.writeFileSync(path.join(dir, 'up'), '');      // the workspace tmux server answers
  await s.tick();                                  // fires the overdue run + arms it
  await s.saveJob(parse({ name: 'nightly', schedule: '0 0 31 12 *', command: 'true' })); // never due again today
  await s.tick();                                  // run still live: skipped + re-armed, no second fire
  fs.writeFileSync(sessions, '');                  // the run session ended
  await s.tick();                                  // -> run finished
  const run = await s.runJob('nightly');           // a manual run arms the same way
  if (!run.ok) { console.log('CHILD-FAIL runJob: ' + run.errorMessage); process.exitCode = 1; return; }
  await s.tick();                                  // live again: skipped + re-armed
  fs.writeFileSync(sessions, '');
  await s.tick();                                  // -> second run finished
  // The seeded row, the catch-up and the manual run; a re-fire while live
  // would add a fourth.
  console.log('CHILD-RUNS ' + db.db().prepare('SELECT origin FROM job_runs').all()
    .map(r => r.origin).sort().join(','));
})().catch(e => { console.log('CHILD-FAIL ' + (e && e.stack || e)); process.exitCode = 1; });
`;

test(
  'tick: fires an overdue run, skips it while it lives, logs its finish; run-now runs too',
  { timeout: 30_000 },
  async () => {
    const fakeDir = fs.mkdtempSync(path.join(dir, 'fake-tmux-'));
    const fakeTmux = path.join(fakeDir, 'tmux');
    fs.writeFileSync(fakeTmux, FAKE_TMUX, { mode: 0o755 });
    const child = path.join(fakeDir, 'runs.js');
    fs.writeFileSync(child, RUNS_CHILD);
    // Empty counts as unset (compose sets it that way): console-only logging.
    const env = {
      ...process.env,
      PATH: `${fakeDir}:${process.env.PATH}`,
      FAKE_TMUX_DIR: fakeDir,
      CYBERMOLE_TMUX_SOCKET: path.join(fakeDir, 'socket'),
      CYBERMOLE_LOKI_URL: '',
      CYBERMOLE_LOKI_JOB: '',
    };
    const { stdout, stderr } = await new Promise((resolve, reject) =>
      execFile(process.execPath, [child], { env, timeout: 20_000 }, (err, out, serr) =>
        err ? reject({ err, out, serr }) : resolve({ stdout: out, stderr: serr }),
      ),
    );
    const out = `${stdout}${stderr}`;
    assert.ok(!out.includes('CHILD-FAIL'), `child failed: ${out}`);
    assert.match(
      out,
      /info +\[scheduler\] job nightly fired \(catchup\) — opening run session cybermole-nightly/,
      'the overdue fire is logged',
    );
    // The session runs the wrapper (its argv is pinned in jobs.test.mjs): an
    // outer sh -c with the command as $1, never embedded.
    assert.match(
      out,
      /info +\[tmux\] tmux session cybermole-nightly started \{"command":"\/bin\/sh -c mkdir -p \\"\$\(dirname/,
      'the run session opening is logged',
    );
    assert.match(
      out,
      /info +\[scheduler\] job nightly fired \(manual\) — opening run session cybermole-nightly/,
      'the run-now fire is logged',
    );
    const finishes = out.split('\n').filter(l => l.includes('run finished'));
    assert.equal(
      finishes.length,
      2,
      `one finish line per run (got ${finishes.length}): ${finishes.join(' | ')}`,
    );
    assert.match(
      finishes[0],
      /info +\[scheduler\] job nightly run finished \(run session cybermole-nightly gone, exit unknown\)/,
      'no exit file under the fake (it never runs the wrapper) → unknown',
    );
    assert.match(
      out,
      /CHILD-RUNS catchup,manual,schedule/,
      'exactly the seeded fire + the catch-up + the run-now — the live run was never re-fired',
    );
  },
);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
