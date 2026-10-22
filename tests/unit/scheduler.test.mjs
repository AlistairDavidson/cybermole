// scheduler.test.mjs — the Scheduler's Result families (src/lib/jobs.ts):
// one case per error code of saveJob / deleteJob / runJob / listJobs (the
// form-shape rules saveJob used to check are JobSaveSchema's now —
// api.test.mjs), and
// the 40-char job-name regression (runs of long names used to be refused by
// tmux's 40-char session-name cap), and the tick's run-lifecycle logging
// (fires, skips a live run, logs its finish) against a fake tmux — the
// last needs no real tmux: a stand-in script on the child's PATH answers
// the three commands src/lib/tmux.ts issues. tmux runs against a private
// ABSOLUTE-path socket set before the import (tmux.ts binds SOCKET at module
// load), so nothing here can touch a real web-pi socket — and with no
// server behind it, opening a run fails with the never-fork guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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
  const db = new StateDb(path.join(fs.mkdtempSync(path.join(dir, 'db-')), 'webpi.db'));
  return new Scheduler(db, {
    cwd: dir,
    env: {},
    logDir: path.join(dir, 'job-logs'),
    logMaxBytes: 20 * 1024 * 1024,
  });
}

/** A Scheduler whose state db can never open (its parent is a file). */
function brokenScheduler() {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'broken-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new Scheduler(new StateDb(path.join(file, 'webpi.db')), {
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
  // saveJob reads the row first now (job_created vs job_updated, plan
  // §7's events), so a broken db fails on that read.
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
    [['nightly', 'webpi-nightly', false]],
  );
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
  assert.deepEqual(unrecorded.data, { name: 'nightly', session: 'webpi-nightly' });
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
        data: { name: 'nightly', session: 'webpi-nightly' },
      });
      const again = await s.runJob('nightly');
      assert.equal(again.errorCode, 'run_active');
      assert.equal(again.data.session, 'webpi-nightly');

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

// ---------- the tick's run lifecycle, against a fake tmux (child) ----------
//
// The scheduler's own logger lines (fires, finishes) are asserted in a
// child process (same reason as logger.test.mjs: capturing this process's
// stdout would fight node:test's own protocol). The child runs with a
// stand-in tmux FIRST on its PATH: $FAKE_TMUX_DIR/up marks the tmux server
// up, $FAKE_TMUX_DIR/sessions lists live session names (new-session appends
// to it), which is everything list-sessions/has-session/new-session need.

const FAKE_TMUX = `#!/bin/sh
# Stand-in tmux (written by scheduler.test.mjs): up/sessions files in
# $FAKE_TMUX_DIR steer it; speaks the commands src/lib/tmux.ts issues.
# list-sessions answers the pipe-field -F format tmux.ts actually sends
# (task/ws-jobs made that matter: the live set drives the finish
# observation) — the human default format would parse as NO sessions.
dir="$FAKE_TMUX_DIR"; sessions="$dir/sessions"
# Created here, not by the test: a missing file would make the read
# redirection below a fatal error in sh and read as a dead server.
[ -e "$sessions" ] || : > "$sessions"
while [ $# -gt 0 ]; do case "$1" in -f|-S|-L) shift 2 ;; *) break ;; esac; done
sub="$1"; shift
case "$sub" in
  list-sessions)
    [ -e "$dir/up" ] || { echo "error connecting to $WEB_PI_TMUX_SOCKET (No such file or directory)" >&2; exit 1; }
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
    [ -e "$dir/up" ] || { echo "error connecting to $WEB_PI_TMUX_SOCKET (No such file or directory)" >&2; exit 1; }
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
const { Scheduler } = require(process.cwd() + '/dist-server/src/lib/jobs.js');
const { StateDb } = require(process.cwd() + '/dist-server/src/lib/db.js');
const { JobSaveSchema } = require(process.cwd() + '/dist-server/src/schemas/jobs.js');
const db = new StateDb(path.join(dir, 'webpi.db'));
const s = new Scheduler(db, {
  cwd: dir,
  env: {},
  logDir: path.join(dir, 'job-logs'),
  logMaxBytes: 20 * 1024 * 1024,
});
// No process.exit in here: it can truncate the pipe-buffered console
// output mid-write; exitCode + natural exit lets the lines drain.
(async () => {
  const parse = (o) => JobSaveSchema.parse(o);
  const saved = await s.saveJob(parse({ name: 'nightly', schedule: '* * * * *', command: 'true' }));
  if (!saved.ok) { console.log('CHILD-FAIL saveJob: ' + saved.errorMessage); process.exitCode = 1; return; }
  // A fire ten minutes ago: the every-minute boundary since is overdue,
  // so the first tick fires it as a catch-up (deterministically > 2 ticks late).
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
  // The origins of every recorded fire: the seeded 'schedule' row, the
  // tick's catch-up, the manual run-now — a re-fire while the run was
  // live would add a fourth.
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
    // WEB_PI_LOKI_URL/'' — empty counts as unset (compose sets it that way
    // on a plain `up`): the child's logger is the console-only shape.
    const env = {
      ...process.env,
      PATH: `${fakeDir}:${process.env.PATH}`,
      FAKE_TMUX_DIR: fakeDir,
      WEB_PI_TMUX_SOCKET: path.join(fakeDir, 'socket'),
      WEB_PI_LOKI_URL: '',
      WEB_PI_LOKI_JOB: '',
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
      /info +\[scheduler\] job nightly fired \(catchup\) — opening run session webpi-nightly/,
      'the overdue fire is logged',
    );
    // The run session now opens the plan §9 wrapper, not the bare
    // command: the exact argv is pinned by jobs.test.mjs; here just the
    // shape — an outer /bin/sh -c whose script tees to a log file, with
    // the user command riding as $1 (never string-embedded).
    assert.match(
      out,
      /info +\[tmux\] tmux session webpi-nightly started \{"command":"\/bin\/sh -c mkdir -p \\"\$\(dirname/,
      'the run session opening is logged',
    );
    assert.match(
      out,
      /info +\[scheduler\] job nightly fired \(manual\) — opening run session webpi-nightly/,
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
      /info +\[scheduler\] job nightly run finished \(run session webpi-nightly gone, exit unknown\)/,
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
