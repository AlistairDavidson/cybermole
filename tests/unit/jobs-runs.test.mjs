// jobs-runs.test.mjs — task/ws-jobs (docs/workspaces-plan.md §9) units:
// the tick's run-finish observation (exit files: success, failure,
// missing → unknown — plus the boot-armed path that only knows the job),
// RUN_HISTORY pruning that unlinks the doomed runs' files BEFORE the
// rows go, listRuns/readRunLog (shape, tail cap, every error code), and
// the app tag's save/list LEFT JOIN. Needs no real tmux: a stand-in
// FIRST on PATH answers the commands src/lib/tmux.ts issues (execFile
// resolves it per call; only the socket path binds at import, and that
// is pointed into this test's temp dir before the import). A run's
// wrapper never executes under the fake — the TEST writes the exit/log
// files the real wrapper would, at exactly the paths runLogPaths gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-jobs-runs-'));
const fakeBin = path.join(dir, 'bin');
fs.mkdirSync(fakeBin);
process.env.CYBERMOLE_TMUX_SOCKET = path.join(dir, 'socket');
process.env.FAKE_TMUX_DIR = dir; // the stand-in's state lives beside it
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const { Scheduler, runLogPaths } = await import('../../dist-server/src/lib/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/db.js');
const { JobSaveSchema } = await import('../../dist-server/src/schemas/jobs.js');

// The stand-in tmux (scheduler.test.mjs's, plus the -F format):
// $FAKE_TMUX/up marks the server up, $FAKE_TMUX/sessions lists live session
// names (new-session appends). list-sessions answers the -F formats
// src/lib/tmux.ts actually sends — '#{session_name}' (liveSessionNames,
// one bare name per line) and the older pipe-field shape anything
// fancier would parse as.
const FAKE_TMUX = `#!/bin/sh
dir="$FAKE_TMUX_DIR"; sessions="$dir/sessions"
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
fs.writeFileSync(path.join(fakeBin, 'tmux'), FAKE_TMUX, { mode: 0o755 });

const parse = o => JobSaveSchema.parse(o);
/** Never due within a test run: Dec 31 — the tick must not fire extras. */
const NOT_DUE = '0 0 31 12 *';

function fresh() {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const logDir = path.join(root, 'job-logs');
  const db = new StateDb(path.join(root, 'cybermole.db'));
  return {
    root,
    logDir,
    db,
    s: new Scheduler(db, { cwd: root, env: {}, logDir, logMaxBytes: 20 * 1024 * 1024 }),
  };
}

/** Seed an app row (the Apps domain's writer is out of scope here) and
 *  return its id. */
function seedApp(db, name) {
  const id = randomUUID();
  db.db()
    .prepare(
      'INSERT INTO apps (id, name, slug, sort_order, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, 10, 0, 0, ?, ?)',
    )
    .run(id, name, name.toLowerCase(), 'tester', 'tester');
  return id;
}

/** A run row as the fire writes it (log path included), with real files
 *  when contents are given. */
function seedRun(logDir, job, firedAt, files) {
  const paths = runLogPaths(logDir, job, firedAt);
  if (files) {
    fs.mkdirSync(path.dirname(paths.log), { recursive: true });
    fs.writeFileSync(paths.log, files.log ?? '');
    if (files.exit !== undefined) fs.writeFileSync(paths.exit, files.exit);
  }
  return paths;
}

const tmuxUp = up => {
  if (up) fs.writeFileSync(path.join(dir, 'up'), '');
  else fs.rmSync(path.join(dir, 'up'), { force: true });
};
const liveSessions = names =>
  fs.writeFileSync(path.join(dir, 'sessions'), names.join('\n') + (names.length ? '\n' : ''));

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---------- the tick's finish observation ----------

test('finish observation: exit files fill exit_code/finished_at; a missing file stays unknown', async () => {
  const { logDir, db, s } = fresh();
  await s.saveJob(parse({ name: 'ok', schedule: NOT_DUE, command: 'true' }));
  await s.saveJob(parse({ name: 'boom', schedule: NOT_DUE, command: 'false' }));
  await s.saveJob(parse({ name: 'nolog', schedule: NOT_DUE, command: 'true' }));
  tmuxUp(true);
  try {
    for (const name of ['ok', 'boom', 'nolog']) assert.equal((await s.runJob(name)).ok, true, name);
    // What the real wrapper would have written by the time the session
    // dies (the exit file is sequenced before the pipeline drains).
    const fired = job =>
      db.db().prepare('SELECT fired_at FROM job_runs WHERE job = ?').get(job).fired_at;
    seedRun(logDir, 'ok', fired('ok'), { log: 'all good\n', exit: '0\n' });
    seedRun(logDir, 'boom', fired('boom'), { log: 'it broke\n', exit: '7\n' });
    seedRun(logDir, 'nolog', fired('nolog'), null); // wrapper never created the files
    liveSessions([]); // every run session ended
    await s.tick();

    const row = job =>
      db.db().prepare('SELECT exit_code, finished_at FROM job_runs WHERE job = ?').get(job);
    assert.equal(row('ok').exit_code, 0);
    assert.ok(row('ok').finished_at >= fired('ok'));
    assert.equal(row('boom').exit_code, 7);
    assert.ok(row('boom').finished_at >= fired('boom'));
    assert.equal(row('nolog').exit_code, null, 'a missing exit file is unknown, never guessed');
    assert.ok(row('nolog').finished_at, 'the finish itself was still observed');

    const jobs = (await s.listJobs()).data.jobs;
    assert.deepEqual(Object.fromEntries(jobs.map(j => [j.name, j.lastResult])), {
      boom: 'failed',
      nolog: 'unknown',
      ok: 'success',
    });
  } finally {
    tmuxUp(false);
  }
});

test('finish observation: a session found already live (boot shape) resolves its newest run', async () => {
  const { logDir, db, s } = fresh();
  await s.saveJob(parse({ name: 'bootrun', schedule: NOT_DUE, command: 'true' }));
  // The run fired while "the server was down": row on disk, session live.
  const firedAt = Date.now() - 60_000;
  db.db()
    .prepare('INSERT INTO job_runs (job, fired_at, origin, log) VALUES (?, ?, ?, ?)')
    .run('bootrun', firedAt, 'schedule', runLogPaths(logDir, 'bootrun', firedAt).log);
  seedRun(logDir, 'bootrun', firedAt, { log: 'from before the restart\n', exit: '0\n' });
  tmuxUp(true);
  liveSessions(['cybermole-bootrun']);
  try {
    await s.tick(); // arms the live session (no fired_at of its own)
    liveSessions([]);
    await s.tick(); // observes the finish on the newest row
    const row = db
      .db()
      .prepare('SELECT exit_code, finished_at FROM job_runs WHERE job = ?')
      .get('bootrun');
    assert.equal(row.exit_code, 0);
    assert.ok(row.finished_at);
  } finally {
    tmuxUp(false);
  }
});

// ---------- pruning unlinks before the delete ----------

test('RUN_HISTORY pruning unlinks the doomed runs’ files before deleting their rows', async () => {
  const { logDir, db, s } = fresh();
  await s.saveJob(parse({ name: 'busy', schedule: NOT_DUE, command: 'true' }));
  const base = Date.now() - 30 * 60_000;
  const paths = [];
  for (let i = 0; i < 20; i++) {
    const at = base + i;
    const p = seedRun(logDir, 'busy', at, { log: `run ${i}\n`, exit: '0\n' });
    db.db()
      .prepare('INSERT INTO job_runs (job, fired_at, origin, log) VALUES (?, ?, ?, ?)')
      .run('busy', at, 'schedule', p.log);
    paths.push(p);
  }
  // tmux down: the fire is recorded (and prunes) BEFORE the spawn fails —
  // the spawn failure is irrelevant to the pruning under test.
  tmuxUp(false);
  assert.equal((await s.runJob('busy')).errorCode, 'tmux_error');

  // The 21st run kept the newest 20: the OLDEST row (and it alone) went.
  const rows = db
    .db()
    .prepare('SELECT fired_at FROM job_runs WHERE job = ? ORDER BY fired_at')
    .all('busy');
  assert.equal(rows.length, 20);
  assert.equal(rows[0].fired_at, base + 1, 'the oldest run was pruned');
  assert.equal(fs.existsSync(paths[0].log), false, 'its log file was unlinked');
  assert.equal(fs.existsSync(paths[0].exit), false, 'its exit file was unlinked');
  for (let i = 1; i < 20; i++) assert.ok(fs.existsSync(paths[i].log), `run ${i} keeps its log`);
});

test('deleteJob removes the job’s whole log dir with the rows', async () => {
  const { logDir, db, s } = fresh();
  await s.saveJob(parse({ name: 'gone', schedule: NOT_DUE, command: 'true' }));
  const at = Date.now();
  const p = seedRun(logDir, 'gone', at, { log: 'x\n' });
  db.db()
    .prepare('INSERT INTO job_runs (job, fired_at, origin, log) VALUES (?, ?, ?, ?)')
    .run('gone', at, 'manual', p.log);
  assert.ok(await s.deleteJob('gone'));
  assert.equal(fs.existsSync(path.join(logDir, 'gone')), false);
  assert.equal(db.db().prepare('SELECT COUNT(*) AS n FROM job_runs').get().n, 0);
});

// ---------- listRuns / readRunLog ----------

test('listRuns: newest first, exit/finish passthrough, hasLog honest about the file', async () => {
  const { logDir, db, s } = fresh();
  await s.saveJob(parse({ name: 'hist', schedule: NOT_DUE, command: 'true' }));
  const base = Date.now() - 60_000;
  const withFile = seedRun(logDir, 'hist', base, { log: 'a\n', exit: '0\n' });
  // base+1: the fire recorded a log path, but the wrapper never created
  // the file (log dir unwritable) — hasLog must say false.
  const rows = [
    { at: base, exit: 0, fin: base + 1000, log: withFile.log }, // file exists
    { at: base + 1, exit: null, fin: null, log: runLogPaths(logDir, 'hist', base + 1).log },
    { at: base + 2, exit: 3, fin: base + 3000, log: null }, // pre-v6 shape: no log at all
  ];
  for (const r of rows) {
    db.db()
      .prepare(
        'INSERT INTO job_runs (job, fired_at, origin, exit_code, finished_at, log) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('hist', r.at, 'manual', r.exit, r.fin, r.log);
  }
  const listed = s.listRuns('hist');
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.data.runs.map(r => [r.firedAt, r.origin, r.exitCode, r.finishedAt, r.hasLog]),
    [
      [base + 2, 'manual', 3, base + 3000, false],
      [base + 1, 'manual', null, null, false],
      [base, 'manual', 0, base + 1000, true],
    ],
  );
});

test('listRuns: job_not_found, database_error', async () => {
  const { s } = fresh();
  assert.equal(s.listRuns('nope').errorCode, 'job_not_found');
  const broken = path.join(fs.mkdtempSync(path.join(dir, 'broken-')), 'x');
  fs.writeFileSync(broken, '');
  assert.equal(
    new Scheduler(new StateDb(path.join(broken, 'db')), {
      cwd: dir,
      env: {},
      logDir: dir,
    }).listRuns('x').errorCode,
    'database_error',
  );
});

test('readRunLog: the tail — content, 1 MiB cap on the NEWEST bytes, truncation flag', async () => {
  const { logDir, db, s } = fresh();
  await s.saveJob(parse({ name: 'logs', schedule: NOT_DUE, command: 'true' }));
  const small = Date.now();
  seedRun(logDir, 'logs', small, { log: 'hello log\nsecond line\n' });
  db.db()
    .prepare('INSERT INTO job_runs (job, fired_at, origin, log) VALUES (?, ?, ?, ?)')
    .run('logs', small, 'manual', runLogPaths(logDir, 'logs', small).log);

  const read = s.readRunLog('logs', small);
  assert.equal(read.ok, true);
  assert.deepEqual(read.data, { text: 'hello log\nsecond line\n', truncated: false });

  // 1.5 MiB: exactly the last 1 MiB, flagged truncated.
  const big = small + 1;
  const paths = seedRun(logDir, 'logs', big, null);
  fs.writeFileSync(
    paths.log,
    'A'.repeat(512 * 1024) + 'B'.repeat(512 * 1024) + 'T'.repeat(512 * 1024),
  );
  db.db()
    .prepare('INSERT INTO job_runs (job, fired_at, origin, log) VALUES (?, ?, ?, ?)')
    .run('logs', big, 'manual', paths.log);
  const tail = s.readRunLog('logs', big);
  assert.equal(tail.ok, true);
  assert.equal(tail.data.truncated, true);
  assert.equal(tail.data.text.length, 1024 * 1024);
  assert.ok(tail.data.text.endsWith('T'.repeat(64)), 'the tail is the NEWEST bytes');
  assert.ok(!tail.data.text.includes('A'), 'the head was dropped');
});

test('readRunLog: every error code — job/run/log_missing/read_error', async () => {
  const { logDir, db, s } = fresh();
  await s.saveJob(parse({ name: 'errs', schedule: NOT_DUE, command: 'true' }));
  const at = Date.now();
  const paths = runLogPaths(logDir, 'errs', at);
  // A row with no log at all (pre-v6 shape).
  db.db()
    .prepare('INSERT INTO job_runs (job, fired_at, origin) VALUES (?, ?, ?)')
    .run('errs', at, 'manual');
  // A row whose wrapper never created the file.
  db.db()
    .prepare('INSERT INTO job_runs (job, fired_at, origin, log) VALUES (?, ?, ?, ?)')
    .run('errs', at + 1, 'manual', paths.log);
  // A row with a log file this process cannot read (root ignores 000).
  const unreadableAt = at + 2;
  const unreadable = seedRun(logDir, 'errs', unreadableAt, { log: 'secret\n' });
  db.db()
    .prepare('INSERT INTO job_runs (job, fired_at, origin, log) VALUES (?, ?, ?, ?)')
    .run('errs', unreadableAt, 'manual', unreadable.log);

  assert.equal(s.readRunLog('nope', at).errorCode, 'job_not_found');
  assert.equal(s.readRunLog('errs', at + 99).errorCode, 'run_not_found');
  assert.equal(s.readRunLog('errs', at).errorCode, 'log_missing');
  assert.equal(s.readRunLog('errs', at + 1).errorCode, 'log_missing');
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(unreadable.log, 0o000);
    assert.equal(s.readRunLog('errs', unreadableAt).errorCode, 'read_error');
  }
  // database_error: a db that cannot open fails the row read.
  const broken = path.join(fs.mkdtempSync(path.join(dir, 'broken-')), 'x');
  fs.writeFileSync(broken, '');
  assert.equal(
    new Scheduler(new StateDb(path.join(broken, 'db')), {
      cwd: dir,
      env: {},
      logDir: dir,
    }).readRunLog('errs', at).errorCode,
    'database_error',
  );
});

// ---------- the app tag ----------

test('saveJob/listJobs: the optional app tag — save, JOIN name, clear, unknown app', async () => {
  const { db, s } = fresh();
  const id = seedApp(db, 'Frontend');
  await s.saveJob(parse({ name: 'tagged', schedule: NOT_DUE, command: 'true', appId: id }));
  await s.saveJob(parse({ name: 'global', schedule: NOT_DUE, command: 'true' }));
  let jobs = (await s.listJobs()).data.jobs;
  assert.deepEqual(Object.fromEntries(jobs.map(j => [j.name, [j.appId, j.appName]])), {
    global: [null, null],
    tagged: [id, 'Frontend'],
  });

  // A valid uuid that names no app row: a closed code, not an FK crash.
  assert.equal(
    (
      await s.saveJob(
        parse({ name: 'ghost', schedule: NOT_DUE, command: 'true', appId: randomUUID() }),
      )
    ).errorCode,
    'app_not_found',
  );

  // Re-saving with null clears the tag (PUT semantics).
  await s.saveJob(parse({ name: 'tagged', schedule: NOT_DUE, command: 'true', appId: null }));
  jobs = (await s.listJobs()).data.jobs;
  assert.deepEqual(jobs.find(j => j.name === 'tagged').appId, null);
});
