// jobs-events.test.mjs — the domain-event bus (src/lib/events.ts) and
// the service-layer emission choke points (src/lib/jobs.ts, plan §7):
// every mutation path emits exactly the right event with the right
// payload, and failure paths emit nothing. The db-only families
// (created/updated/deleted) run in-process; the run lifecycle
// (started/killed/finished) needs tmux — real tmux for the happy path
// (private ABSOLUTE socket, set before the import so nothing can touch a
// real cybermole socket), and a stand-in tmux on PATH for killRun's error
// codes (deterministic, no server needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-jobs-events-'));
process.env.CYBERMOLE_TMUX_SOCKET = path.join(dir, 'tmux');
const SOCKET = process.env.CYBERMOLE_TMUX_SOCKET;

const { Scheduler } = await import('../../dist-server/src/lib/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/db.js');
const { JobSaveSchema } = await import('../../dist-server/src/schemas/jobs.js');
const { onDomainEvent, emitDomainEvent } = await import('../../dist-server/src/lib/events.js');

const parsed = input => JobSaveSchema.parse(input);
const GOOD = { name: 'nightly', schedule: '*/5 * * * *', command: 'true' };

const haveTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Scheduler + its db handle (to read fired_at rows back). */
function fresh() {
  const db = new StateDb(path.join(fs.mkdtempSync(path.join(dir, 'db-')), 'cybermole.db'));
  return {
    db,
    s: new Scheduler(db, { cwd: dir, env: {}, logDir: path.join(dir, 'job-logs') }),
  };
}

/** A Scheduler whose state db can never open (its parent is a file). */
function brokenScheduler() {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'broken-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new Scheduler(new StateDb(path.join(file, 'cybermole.db')), {
    cwd: dir,
    env: {},
    logDir: path.join(dir, 'job-logs'),
  });
}

/** Collect bus events for the duration of `body` (always unsubscribes —
 *  the bus is a module singleton shared by every test here). */
async function collecting(body) {
  const events = [];
  const off = onDomainEvent(e => events.push(e));
  try {
    await body(events);
  } finally {
    off();
  }
  return events;
}

const newestFiredAt = db =>
  db.db().prepare('SELECT fired_at FROM job_runs WHERE job = ?').get('nightly').fired_at;

test('the bus: a listener receives every event; unsubscribe stops it; payloads pass through', () => {
  const seen = [];
  const off = onDomainEvent(e => seen.push(e));
  emitDomainEvent({ topic: 'jobs', type: 'job_created', job: 'x' });
  emitDomainEvent({ topic: 'jobs', type: 'run_finished', job: 'x', firedAt: 42 });
  off();
  emitDomainEvent({ topic: 'jobs', type: 'job_deleted', job: 'x' });
  assert.deepEqual(seen, [
    { topic: 'jobs', type: 'job_created', job: 'x' },
    { topic: 'jobs', type: 'run_finished', job: 'x', firedAt: 42 },
  ]);
});

test('saveJob: job_created first, job_updated after; failures emit nothing', async () => {
  const events = await collecting(async () => {
    const { s } = fresh();
    assert.ok((await s.saveJob(parsed(GOOD))).ok);
    assert.ok((await s.saveJob(parsed({ ...GOOD, schedule: '0 8 * * *' }))).ok);
    // invalid input and a dead db never reach the write — no event.
    assert.equal(
      (await s.saveJob(parsed({ ...GOOD, schedule: 'daily' }))).errorCode,
      'invalid_schedule',
    );
    assert.equal((await brokenScheduler().saveJob(parsed(GOOD))).errorCode, 'database_error');
  });
  assert.deepEqual(events, [
    { topic: 'jobs', type: 'job_created', job: 'nightly' },
    { topic: 'jobs', type: 'job_updated', job: 'nightly' },
  ]);
});

test('deleteJob: job_deleted on success; not-found and db failures emit nothing', async () => {
  const events = await collecting(async () => {
    const { s } = fresh();
    await s.saveJob(parsed(GOOD));
    assert.ok((await s.deleteJob('nightly')).ok);
    assert.equal((await s.deleteJob('nightly')).errorCode, 'job_not_found');
    assert.equal((await brokenScheduler().deleteJob('nightly')).errorCode, 'database_error');
  });
  assert.deepEqual(events, [
    { topic: 'jobs', type: 'job_created', job: 'nightly' },
    { topic: 'jobs', type: 'job_deleted', job: 'nightly' },
  ]);
});

test('killRun: every error code; only a successful kill emits run_killed', async () => {
  // Stand-in tmux on PATH: `up` marks the server up, `sessions` lists
  // live sessions, `kill-fails` makes kill-session fail — everything
  // killRun's checks issue (src/lib/tmux.ts has-session / kill-session).
  const fakeDir = fs.mkdtempSync(path.join(dir, 'fake-tmux-'));
  fs.writeFileSync(
    path.join(fakeDir, 'tmux'),
    `#!/bin/sh
dir="$FAKE_TMUX_DIR"; sessions="$dir/sessions"
[ -e "$sessions" ] || : > "$sessions"
while [ $# -gt 0 ]; do case "$1" in -f|-S|-L) shift 2 ;; *) break ;; esac; done
sub="$1"; shift
[ -e "$dir/up" ] || { echo "error connecting to socket (No such file or directory)" >&2; exit 1; }
case "$sub" in
  has-session|kill-session)
    target=""
    while [ $# -gt 0 ]; do [ "$1" = "-t" ] && { target="$2"; shift 2; continue; }; shift; done
    grep -qx "$target" "$sessions" || exit 1
    [ "$sub" = kill-session ] && [ -e "$dir/kill-fails" ] && { echo "kill refused" >&2; exit 1; }
    [ "$sub" = kill-session ] && { grep -vx "$target" "$sessions" > "$sessions.new"; mv "$sessions.new" "$sessions"; }
    ;;
  *) echo "fake-tmux: unsupported subcommand: $sub" >&2; exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${process.env.PATH}`;
  process.env.FAKE_TMUX_DIR = fakeDir;
  try {
    const events = await collecting(async () => {
      const { db, s } = fresh();
      await s.saveJob(parsed(GOOD));
      db.db()
        .prepare('INSERT INTO job_runs (job, fired_at, origin) VALUES (?, ?, ?)')
        .run('nightly', 1000, 'manual');

      assert.equal((await s.killRun('nope', 1000)).errorCode, 'job_not_found');
      assert.equal((await s.killRun('nightly', 999)).errorCode, 'run_not_found');
      // server down (no `up` file): has-session fails → run_not_active
      // (the reconciled family from task/jobs-socket — plan §4's route
      // asserts the same codes; the event still must NOT fire)
      assert.equal((await s.killRun('nightly', 1000)).errorCode, 'run_not_active');

      fs.writeFileSync(path.join(fakeDir, 'up'), '');
      fs.writeFileSync(path.join(fakeDir, 'sessions'), 'cybermole-nightly\n');
      // the named run is not the live one: a NEWER row exists
      db.db()
        .prepare('INSERT INTO job_runs (job, fired_at, origin) VALUES (?, ?, ?)')
        .run('nightly', 2000, 'manual');
      assert.equal((await s.killRun('nightly', 1000)).errorCode, 'run_not_active');

      // the newest run, live, but kill-session fails → tmux_error
      fs.writeFileSync(path.join(fakeDir, 'kill-fails'), '');
      assert.equal((await s.killRun('nightly', 2000)).errorCode, 'tmux_error');
      fs.rmSync(path.join(fakeDir, 'kill-fails'));

      // happy path: the kill lands, run_killed fires (data shape is the
      // reconciled { name, firedAt } — the session is derivable, the
      // internal API's route passes it through)
      const killed = await s.killRun('nightly', 2000);
      assert.deepEqual(killed, {
        ok: true,
        resultType: 'kill_run',
        data: { name: 'nightly', firedAt: 2000 },
      });
    });
    assert.deepEqual(events, [
      { topic: 'jobs', type: 'job_created', job: 'nightly' },
      { topic: 'jobs', type: 'run_killed', job: 'nightly', firedAt: 2000 },
    ]);
  } finally {
    process.env.PATH = previousPath;
    delete process.env.FAKE_TMUX_DIR;
  }
});

test('killRun: database_error when the job or runs cannot be read', async () => {
  const failed = await brokenScheduler().killRun('nightly', 1000);
  assert.equal(failed.errorCode, 'database_error');
  assert.match(failed.errorMessage, /^could not read job: /);
});

test('a fire that cannot spawn emits no run_started (nothing started)', async () => {
  // No tmux server behind the socket: the fire is spent (recorded) but
  // the run never opened — run_started must NOT fire.
  const events = await collecting(async () => {
    const { s } = fresh();
    await s.saveJob(parsed(GOOD));
    const refused = await s.runJob('nightly');
    assert.equal(refused.ok, false);
  });
  assert.deepEqual(events, [{ topic: 'jobs', type: 'job_created', job: 'nightly' }]);
});

test(
  'the run lifecycle: run_now → run_started, kill → run_killed, the tick observes the end → run_finished',
  { skip: !haveTmux, timeout: 30_000 },
  async () => {
    const conf = path.join(dir, 'server.conf');
    fs.writeFileSync(conf, 'set -g exit-empty off\n');
    execFileSync('tmux', ['-S', SOCKET, '-f', conf, 'start-server']);
    try {
      let firedAt;
      const events = await collecting(async () => {
        const { db, s } = fresh();
        await s.saveJob(parsed({ ...GOOD, command: 'sleep 30' }));
        const run = await s.runJob('nightly');
        assert.ok(run.ok, run.errorMessage);
        firedAt = newestFiredAt(db);

        const kill = await s.killRun('nightly', firedAt);
        assert.ok(kill.ok, kill.errorMessage);

        // The tick sees the session gone and records the finish →
        // run_finished (at OBSERVATION time, not process exit).
        await s.tick();
        const row = db
          .db()
          .prepare('SELECT exit_code, finished_at FROM job_runs WHERE fired_at = ?')
          .get(firedAt);
        assert.notEqual(row.finished_at, null, 'the finish was recorded');
      });
      assert.deepEqual(
        events.map(e => [e.topic, e.type]),
        [
          // the saveJob inside the block emits first — the lifecycle
          // assertions below are about the RUN events
          ['jobs', 'job_created'],
          ['jobs', 'run_started'],
          ['jobs', 'run_killed'],
          ['jobs', 'run_finished'],
        ],
      );
      assert.ok(
        events.every(e => e.job === 'nightly'),
        `every payload names the job: ${JSON.stringify(events)}`,
      );
      assert.ok(
        events.filter(e => e.type !== 'job_created').every(e => e.firedAt === firedAt),
        `every run event names the run: ${JSON.stringify(events)}`,
      );
    } finally {
      try {
        execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' });
      } catch {
        /* gone */
      }
    }
  },
);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
