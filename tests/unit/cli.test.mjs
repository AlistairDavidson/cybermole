// cli.test.mjs — task/jobs-cli (docs/jobs-agent-plan.md §5) units: the
// `webpi` CLI, driven against a REAL internal API booted on a tmp-dir
// socket (the internal-api.test.mjs pattern, including its fake-tmux
// stand-in for run/kill). The command layer runs IN-PROCESS — runCli
// with captured stdout/stderr, exit codes as return values — and the
// bin-level behavior (entry guard, argv, process.exitCode, socket
// discovery env rules) runs in CHILD processes, env.ts's module-load
// capture being exactly why. The Content-Length discipline (the
// internal API refuses chunked bodies with 411) is asserted at the
// wire level against a header-recording server, and every body-carrying
// verb reaching the real API below is the no-411 proof in practice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-cli-'));
const fakeBin = path.join(dir, 'bin');
fs.mkdirSync(fakeBin);
process.env.WEB_PI_TMUX_SOCKET = path.join(dir, 'tmux');
process.env.FAKE_TMUX_DIR = dir;
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
// One socket path for the whole file (env.ts reads WEB_PI_* at module
// load): each case boots its own world — db, scheduler, apps, API — on
// it, closing the previous listener first, like internal-api.test.mjs
// boots per case.
const SOCKET = path.join(dir, 'webpi.sock');
process.env.WEB_PI_SOCK = SOCKET;

const { startInternalApi } = await import('../../dist-server/server/internal-api.js');
const { Scheduler, runLogPaths } = await import('../../dist-server/src/lib/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/db.js');
const { Apps } = await import('../../dist-server/src/lib/apps.js');
const { runCli } = await import('../../dist-server/cli/main.js');
const { internalRequest } = await import('../../dist-server/cli/client.js');

// The internal-api stand-in tmux (kill-session included — the kill verb
// issues it): $dir/up marks the server up, $dir/sessions lists live
// session names, $dir/kill-fail makes kill-session fail (tmux_error).
const FAKE_TMUX = `#!/bin/sh
dir="$FAKE_TMUX_DIR"; sessions="$dir/sessions"
[ -e "$sessions" ] || : > "$sessions"
while [ $# -gt 0 ]; do case "$1" in -f|-S|-L) shift 2 ;; *) break ;; esac; done
sub="$1"; shift
case "$sub" in
  list-sessions)
    [ -e "$dir/up" ] || { echo "error connecting to $WEB_PI_TMUX_SOCKET (No such file or directory)" >&2; exit 1; }
    fmt=""
    while [ $# -gt 0 ]; do [ "$1" = "-F" ] && { fmt="$2"; shift 2; continue; }; shift; done
    while IFS= read -r name; do [ "$fmt" = '#{session_name}' ] && echo "$name" || echo "$name|1|0||"; done < "$sessions"
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
  kill-session)
    [ -e "$dir/up" ] || exit 1
    [ -e "$dir/kill-fail" ] && exit 1
    while [ $# -gt 0 ]; do [ "$1" = "-t" ] && { grep -vx "$2" "$sessions" > "$sessions.x" 2>/dev/null || : > "$sessions.x"; mv "$sessions.x" "$sessions"; exit 0; }; shift; done
    exit 1
    ;;
  *) echo "fake-tmux: unsupported subcommand: $sub" >&2; exit 1 ;;
esac
`;
fs.writeFileSync(path.join(fakeBin, 'tmux'), FAKE_TMUX, { mode: 0o755 });

/** Captured output — the Output interface the command layer takes. */
function capture() {
  const out = [];
  const err = [];
  return {
    out: t => out.push(t),
    err: t => err.push(t),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/** One case's world on the shared socket: fresh db + scheduler + apps +
 * API. The fake tmux server is "up" from the start (run/kill work); each
 * case starts with no live sessions. */
async function boot() {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const logDir = path.join(root, 'job-logs');
  const db = new StateDb(path.join(root, 'webpi.db'));
  const scheduler = new Scheduler(db, {
    cwd: root,
    env: {},
    logDir,
    logMaxBytes: 20 * 1024 * 1024,
  });
  const apps = new Apps({
    db,
    username: () => ({ ok: true, data: { value: 'unit' } }),
    killSession: async () => true,
  });
  fs.writeFileSync(path.join(dir, 'sessions'), '');
  fs.writeFileSync(path.join(dir, 'up'), '');
  const api = await startInternalApi({ socketPath: SOCKET, scheduler, apps });
  return { root, logDir, db, scheduler, apps, api };
}

/** One raw HTTP request over the socket (the internal-api test's call)
 *  — the parity oracle: what the CLI prints with --json must be this
 *  body, byte for byte. */
function call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path: urlPath,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* the log route answers text/plain */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body === undefined) req.end();
    else req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

/** The bin as a child process (the in-process layer cannot re-read
 *  env.ts's module-load env capture — the editor/internal-api test
 *  pattern). Returns {status, stdout, stderr} for ANY exit code. */
function bin(args, env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'WEB_PI_SOCK'),
  );
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join('dist-server', 'cli', 'main.js'), ...args],
      { env: { ...clean, ...env }, encoding: 'utf8' },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const run = (args, io) => runCli(['jobs', ...args], io);

// ---------- the help surface (plan §5: the agent-facing docs) ----------

test('webpi --help / webpi: the top-level documentation, exit 0', async () => {
  for (const argv of [[], ['--help'], ['-h']]) {
    const io = capture();
    assert.equal(await runCli(argv, io), 0);
    assert.match(io.stdout(), /webpi — the web-pi command line/);
    assert.match(io.stdout(), /WEB_PI_SOCK/);
    assert.match(io.stdout(), /Exit codes:/);
    assert.equal(io.stderr(), '');
  }
});

test('webpi jobs: the group help names every verb, one example line each', async () => {
  const io = capture();
  assert.equal(await runCli(['jobs'], io), 0);
  const help = io.stdout();
  for (const verb of [
    'list',
    'runs',
    'log',
    'create',
    'set',
    'delete',
    'run',
    'kill',
    'validate',
  ]) {
    assert.match(help, new RegExp(`\\b${verb}\\b`), `${verb} in the group help`);
    assert.match(help, new RegExp(`webpi jobs ${verb} `), `an example line for ${verb}`);
  }
  assert.match(help, /parity with the \/jobs page/);
});

test('every verb answers --help (and -h) without needing a server', async () => {
  // Nothing is booted yet — help must not touch the socket.
  for (const verb of [
    'list',
    'runs',
    'log',
    'create',
    'set',
    'delete',
    'run',
    'kill',
    'validate',
  ]) {
    for (const helpFlag of ['--help', '-h']) {
      const io = capture();
      assert.equal(await run([verb, helpFlag], io), 0);
      assert.match(io.stdout(), new RegExp(`webpi jobs ${verb}`), `${verb} --help synopsis`);
      assert.equal(io.stderr(), '');
    }
  }
});

test('usage errors: unknown group/verb/option, wrong arity — exit 2', async () => {
  const cases = [
    [['bogus'], /unknown group 'bogus'/],
    [['--wat'], /unknown option '--wat'/],
    [['jobs', 'bogus'], /unknown jobs verb 'bogus'/],
    [['jobs', 'list', 'extra'], /list takes no positional/],
    [['jobs', 'runs'], /runs takes exactly one/],
    [['jobs', 'log', 'only-one'], /log takes a job name and a firedAt/],
    [['jobs', 'kill', 'a', 'b', 'c'], /kill takes a job name and a firedAt/],
    [['jobs', 'create', '--name'], /--name needs a value/],
    [['jobs', 'create', '-n'], /-n needs a value/],
    [
      ['jobs', 'create', '--schedule', '0 4 * * *'],
      /create needs --name, --schedule and --command/,
    ],
    [['jobs', 'set', 'nightly'], /nothing to set/],
    [['jobs', 'validate'], /nothing to validate/],
    [['jobs', 'list', '--bogus'], /unknown option --bogus/],
    [['jobs', 'set', 'n', '--app', 'x', '--clear-app'], /--app and --clear-app contradict/],
  ];
  for (const [argv, pattern] of cases) {
    const io = capture();
    assert.equal(await runCli(argv, io), 2, `${argv.join(' ')} exits 2`);
    assert.match(io.stderr(), pattern, `${argv.join(' ')} message`);
  }
});

// ---------- no server on the socket (the friendly knob-naming error) ----------

test('in-process: no server on the socket — exit 1, the error names WEB_PI_SOCK', async () => {
  const io = capture();
  assert.equal(await run(['list'], io), 1);
  assert.match(io.stderr(), /cannot reach the internal API/);
  assert.match(io.stderr(), new RegExp(SOCKET));
  assert.match(io.stderr(), /WEB_PI_SOCK/);
});

test('bin: a missing socket file (ENOENT) — exit 1, friendly, names the knob', () => {
  const r = bin(['jobs', 'list'], { WEB_PI_SOCK: path.join(dir, 'gone', 'webpi.sock') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot reach the internal API/);
  assert.match(r.stderr, /ENOENT/);
  assert.match(r.stderr, /WEB_PI_SOCK/);
});

test('bin: a stale socket file (ECONNREFUSED — the dead-server case)', () => {
  const stale = path.join(fs.mkdtempSync(path.join(dir, 'stale-')), 'webpi.sock');
  fs.writeFileSync(stale, '');
  const r = bin(['jobs', 'list'], { WEB_PI_SOCK: stale });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ECONNREFUSED/);
  assert.match(r.stderr, /no web-pi server is listening there/);
  assert.match(r.stderr, /WEB_PI_SOCK/);
});

test('bin: EMPTY WEB_PI_SOCK — the listener is off, and the CLI says so', () => {
  const r = bin(['jobs', 'list'], { WEB_PI_SOCK: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /internal API is disabled/);
  assert.match(r.stderr, /WEB_PI_SOCK/);
});

test("bin: a set-but-non-absolute WEB_PI_SOCK is env.ts's own error, as text", () => {
  const r = bin(['jobs', 'list'], { WEB_PI_SOCK: 'webpi.sock' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be an absolute socket path/);
});

test('bin: unset WEB_PI_SOCK = the shape default (env.ts, reused not duplicated)', () => {
  const stateDir = fs.mkdtempSync(path.join(dir, 'state-'));
  const r = bin(['jobs', 'list'], { WEB_PI_STATE_DIR: stateDir });
  assert.equal(r.status, 1);
  const expected = fs.existsSync('/run/web-pi')
    ? '/run/web-pi/webpi.sock'
    : path.join(stateDir, 'webpi.sock');
  assert.ok(r.stderr.includes(expected), `names the default ${expected}`);
});

// ---------- the verbs, against a real internal API ----------

test('create → list: happy paths, human + --json parity with the raw body', async () => {
  const w = await boot();
  try {
    const io = capture();
    assert.equal(
      await run(
        ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'echo hello'],
        io,
      ),
      0,
    );
    assert.equal(io.stdout(), 'job nightly saved\n');

    const listed = capture();
    assert.equal(await run(['list'], listed), 0);
    assert.match(listed.stdout(), /NAME\s+SCHEDULE/);
    assert.match(listed.stdout(), /nightly\s+0 4 \* \* \*\s+echo hello/);

    // --json is the server's body VERBATIM (the scripting contract)
    const raw = await call('GET', '/jobs');
    const jsonIo = capture();
    assert.equal(await run(['list', '--json'], jsonIo), 0);
    assert.equal(jsonIo.stdout(), raw.text);
    assert.equal(JSON.parse(jsonIo.stdout()).jobs[0].command, 'echo hello');

    // short aliases, the documented create example shape
    assert.equal(
      await run(['create', '-n', 'rebuild', '-s', '*/15 * * * *', '-c', 'make build'], capture()),
      0,
    );
    assert.equal((await call('GET', '/jobs')).json.jobs.length, 2);
  } finally {
    await w.api.close();
  }
});

test("create: the app tag (uuid, the form picker's value) rides the save", async () => {
  const w = await boot();
  try {
    const app = await w.apps.saveApp('Deploy Tools');
    assert.equal(app.ok, true);
    const io = capture();
    assert.equal(
      await run(
        [
          'create',
          '--name',
          'rebuild',
          '--schedule',
          '0 6 * * *',
          '--command',
          'make',
          '--app',
          app.data.id,
        ],
        io,
      ),
      0,
    );
    const listed = (await call('GET', '/jobs')).json;
    const job = listed.jobs.find(j => j.name === 'rebuild');
    assert.equal(job.appId, app.data.id);
    assert.equal(job.appName, 'Deploy Tools');
    // the human table shows the tag's display name
    const table = capture();
    assert.equal(await run(['list'], table), 0);
    assert.match(table.stdout(), /rebuild\s+0 6 \* \* \*\s+make\s+Deploy Tools/);
  } finally {
    await w.api.close();
  }
});

test('list -a <slug>: filters; unknown slug and bad slug are server answers', async () => {
  const w = await boot();
  try {
    const app = await w.apps.saveApp('Deploy Tools');
    await run(
      ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'echo hello'],
      capture(),
    );
    await run(
      [
        'create',
        '--name',
        'rebuild',
        '--schedule',
        '0 6 * * *',
        '--command',
        'make',
        '--app',
        app.data.id,
      ],
      capture(),
    );

    const io = capture();
    assert.equal(await run(['list', '-a', 'deploy-tools'], io), 0);
    assert.match(io.stdout(), /rebuild/);
    assert.doesNotMatch(io.stdout(), /nightly/);

    const unknown = capture();
    assert.equal(await run(['list', '-a', 'no-such-app'], unknown), 1);
    assert.match(unknown.stderr(), /no such app/);
    assert.match(unknown.stderr(), /app_not_found/);

    const bad = capture();
    assert.equal(await run(['list', '-a', '//'], bad), 1);
    assert.match(bad.stderr(), /invalid_app_slug/);
  } finally {
    await w.api.close();
  }
});

test('create failure paths: invalid schedule and invalid name (issues printed)', async () => {
  const w = await boot();
  try {
    const schedule = capture();
    assert.equal(
      await run(
        ['create', '--name', 'x', '--schedule', '99 * * * *', '--command', 'true'],
        schedule,
      ),
      1,
    );
    assert.match(schedule.stderr(), /invalid_schedule/);

    // "webpi-…" is reserved (JOB_NAME_RE) — the 400 carries per-field issues
    const name = capture();
    assert.equal(
      await run(
        ['create', '--name', 'webpi-x', '--schedule', '0 4 * * *', '--command', 'true'],
        name,
      ),
      1,
    );
    assert.match(name.stderr(), /webpi: name: use letters, digits, - and _/);
    assert.match(name.stderr(), /code: validation_failure/);

    // --json on failure prints the raw failure body, exit still nonzero
    const json = capture();
    assert.equal(
      await run(
        ['create', '--name', 'webpi-x', '--schedule', '0 4 * * *', '--command', 'true', '--json'],
        json,
      ),
      1,
    );
    const raw = await call('POST', '/jobs', {
      name: 'webpi-x',
      schedule: '0 4 * * *',
      command: 'true',
    });
    assert.equal(json.stdout(), raw.text);
  } finally {
    await w.api.close();
  }
});

test('set: absent keeps, provided sets; --clear-app removes the tag', async () => {
  const w = await boot();
  try {
    const app = await w.apps.saveApp('Deploy Tools');
    await run(
      [
        'create',
        '--name',
        'nightly',
        '--schedule',
        '0 4 * * *',
        '--command',
        'echo hello',
        '--app',
        app.data.id,
      ],
      capture(),
    );

    const io = capture();
    assert.equal(await run(['set', 'nightly', '--schedule', '30 5 * * *'], io), 0);
    assert.equal(io.stdout(), 'job nightly saved\n');
    let job = (await call('GET', '/jobs')).json.jobs[0];
    assert.equal(job.schedule, '30 5 * * *'); // set
    assert.equal(job.command, 'echo hello'); // kept
    assert.equal(job.appId, app.data.id); // kept

    await run(['set', 'nightly', '--command', 'echo bye', '--clear-app'], capture());
    job = (await call('GET', '/jobs')).json.jobs[0];
    assert.equal(job.command, 'echo bye');
    assert.equal(job.appId, null);

    const ghost = capture();
    assert.equal(await run(['set', 'ghost', '--schedule', '0 4 * * *'], ghost), 1);
    assert.match(ghost.stderr(), /no such job/);
    assert.match(ghost.stderr(), /job_not_found/);
  } finally {
    await w.api.close();
  }
});

test('delete: happy path and job_not_found; the empty list says so', async () => {
  const w = await boot();
  try {
    await run(
      ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'true'],
      capture(),
    );
    const io = capture();
    assert.equal(await run(['delete', 'nightly'], io), 0);
    assert.equal(io.stdout(), 'job nightly deleted\n');

    const empty = capture();
    assert.equal(await run(['list'], empty), 0);
    assert.equal(empty.stdout(), 'no jobs\n');

    const ghost = capture();
    assert.equal(await run(['delete', 'nightly'], ghost), 1);
    assert.match(ghost.stderr(), /no such job \(code: job_not_found\)/);
  } finally {
    await w.api.close();
  }
});

test('run: ok means FIRED — the output says so; run_active while one is live', async () => {
  const w = await boot();
  try {
    await run(
      ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'echo hello'],
      capture(),
    );

    const io = capture();
    assert.equal(await run(['run', 'nightly'], io), 0);
    assert.match(io.stdout(), /job nightly fired — run session webpi-nightly is open/);
    assert.match(io.stdout(), /fired = the session opened, not the command finished/);
    assert.match(io.stdout(), /webpi jobs runs nightly/);

    // the previous run is still live in the fake tmux
    const busy = capture();
    assert.equal(await run(['run', 'nightly'], busy), 1);
    assert.match(busy.stderr(), /run_active/);

    const ghost = capture();
    assert.equal(await run(['run', 'ghost'], ghost), 1);
    assert.match(ghost.stderr(), /job_not_found/);
  } finally {
    await w.api.close();
  }
});

test('runs: the history table carries the epoch firedAt (log/kill addressing)', async () => {
  const w = await boot();
  try {
    await run(
      ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'echo hello'],
      capture(),
    );
    assert.equal(await run(['run', 'nightly'], capture()), 0);

    const io = capture();
    assert.equal(await run(['runs', 'nightly'], io), 0);
    const firedAt = String((await call('GET', '/jobs/nightly/runs')).json.runs[0].firedAt);
    assert.match(io.stdout(), /FIRED-AT\s+AT\s+ORIGIN\s+EXIT\s+FINISHED\s+LOG/);
    assert.match(
      io.stdout(),
      new RegExp(`${firedAt}\\s+\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\s+manual`),
    );

    const raw = await call('GET', '/jobs/nightly/runs');
    const json = capture();
    assert.equal(await run(['runs', 'nightly', '--json'], json), 0);
    assert.equal(json.stdout(), raw.text);
  } finally {
    await w.api.close();
  }
});

test('runs: a job with no history; log_missing when the run left no file', async () => {
  const w = await boot();
  try {
    await run(
      ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'true'],
      capture(),
    );
    const empty = capture();
    assert.equal(await run(['runs', 'nightly'], empty), 0);
    assert.equal(empty.stdout(), 'no runs recorded for nightly\n');

    assert.equal(await run(['run', 'nightly'], capture()), 0);
    const firedAt = (await call('GET', '/jobs/nightly/runs')).json.runs[0].firedAt;
    const missing = capture();
    assert.equal(await run(['log', 'nightly', String(firedAt)], missing), 1);
    assert.match(missing.stderr(), /log_missing/);
  } finally {
    await w.api.close();
  }
});

test('log: the tail verbatim; --json wraps it; the 1 MiB cap is disclosed', async () => {
  const w = await boot();
  try {
    await run(
      ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'true'],
      capture(),
    );
    assert.equal(await run(['run', 'nightly'], capture()), 0);
    const firedAt = (await call('GET', '/jobs/nightly/runs')).json.runs[0].firedAt;

    // the TEST writes what the wrapper would (the fake tmux never runs it)
    const paths = runLogPaths(w.logDir, 'nightly', firedAt);
    fs.mkdirSync(path.dirname(paths.log), { recursive: true });
    fs.writeFileSync(paths.log, 'line one\nline two\n');

    const io = capture();
    assert.equal(await run(['log', 'nightly', String(firedAt)], io), 0);
    assert.equal(io.stdout(), 'line one\nline two\n');
    assert.equal(io.stderr(), '');

    const json = capture();
    assert.equal(await run(['log', 'nightly', String(firedAt), '--json'], json), 0);
    assert.deepEqual(JSON.parse(json.stdout()), {
      name: 'nightly',
      firedAt,
      truncated: false,
      text: 'line one\nline two\n',
    });

    // over the tail cap: newest 1 MiB + the truncation note on stderr
    const MiB = 1024 * 1024;
    fs.writeFileSync(paths.log, Buffer.alloc(MiB + 10, 0x61));
    const truncated = capture();
    assert.equal(await run(['log', 'nightly', String(firedAt)], truncated), 0);
    assert.equal(Buffer.byteLength(truncated.stdout()), MiB);
    assert.match(truncated.stderr(), /1 MiB tail/);

    const noRun = capture();
    assert.equal(await run(['log', 'nightly', '123'], noRun), 1);
    assert.match(noRun.stderr(), /run_not_found/);
  } finally {
    await w.api.close();
  }
});

test('kill: the live run dies; every failure code of the family', async () => {
  const w = await boot();
  try {
    await run(
      ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'true'],
      capture(),
    );
    assert.equal(await run(['run', 'nightly'], capture()), 0);
    const firedAt = (await call('GET', '/jobs/nightly/runs')).json.runs[0].firedAt;

    // tmux_error: the fake tmux's kill-fail marker, session still live
    fs.writeFileSync(path.join(dir, 'kill-fail'), '');
    try {
      const failed = capture();
      assert.equal(await run(['kill', 'nightly', String(firedAt)], failed), 1);
      assert.match(failed.stderr(), /could not kill the run session \(code: tmux_error\)/);
      assert.match(failed.stderr(), /webpi-nightly/); // the detail line
    } finally {
      fs.rmSync(path.join(dir, 'kill-fail'), { force: true });
    }

    const io = capture();
    assert.equal(await run(['kill', 'nightly', String(firedAt)], io), 0);
    assert.equal(io.stdout(), `run ${firedAt} of job nightly killed\n`);

    // already killed: not the live run anymore
    const again = capture();
    assert.equal(await run(['kill', 'nightly', String(firedAt)], again), 1);
    assert.match(again.stderr(), /run_not_active/);

    // a firedAt no run recorded under
    const noRun = capture();
    assert.equal(await run(['kill', 'nightly', '123'], noRun), 1);
    assert.match(noRun.stderr(), /run_not_found/);

    // an unknown job
    const ghost = capture();
    assert.equal(await run(['kill', 'ghost', '123'], ghost), 1);
    assert.match(ghost.stderr(), /job_not_found/);

    // a newer run must never be killed by an older firedAt
    assert.equal(await run(['run', 'nightly'], capture()), 0);
    const stale = capture();
    assert.equal(await run(['kill', 'nightly', String(firedAt)], stale), 1);
    assert.match(stale.stderr(), /run_not_active/);
    const secondFiredAt = (await call('GET', '/jobs/nightly/runs')).json.runs[0].firedAt;
    assert.notEqual(secondFiredAt, firedAt); // the newer run survived
  } finally {
    await w.api.close();
  }
});

test('validate: valid is 0, invalid is 1 (an ANSWER, not a failure), usage is 2', async () => {
  const w = await boot();
  try {
    const ok = capture();
    assert.equal(await run(['validate', '--schedule', '*/5 * * * *', '--command', 'true'], ok), 0);
    assert.match(
      ok.stdout(),
      /schedule: valid — next fire \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(local\)/,
    );
    assert.match(ok.stdout(), /command: valid/);

    const badSchedule = capture();
    assert.equal(await run(['validate', '-s', '99 * * * *'], badSchedule), 1);
    assert.match(badSchedule.stdout(), /schedule: invalid — /);

    const badCommand = capture();
    assert.equal(await run(['validate', '-c', ''], badCommand), 1);
    assert.match(badCommand.stdout(), /command: invalid — /);

    // --json: the raw answer, and the exit code still carries validity
    const json = capture();
    assert.equal(await run(['validate', '--schedule', 'nope', '--json'], json), 1);
    const raw = await call('POST', '/jobs/validate', { schedule: 'nope' });
    assert.equal(json.stdout(), raw.text);
    assert.equal(raw.json.schedule.valid, false);
  } finally {
    await w.api.close();
  }
});

// ---------- the full agent flow, one command after another ----------

test('the agent flow: validate → create → run → runs → log → kill → delete', async () => {
  const w = await boot();
  try {
    assert.equal(
      await run(['validate', '--schedule', '0 4 * * *', '--command', 'echo done'], capture()),
      0,
    );
    assert.equal(
      await run(
        ['create', '--name', 'nightly', '--schedule', '0 4 * * *', '--command', 'echo done'],
        capture(),
      ),
      0,
    );
    assert.equal(await run(['run', 'nightly'], capture()), 0);

    // an agent reads firedAt out of the runs answer (jq-style)
    const json = capture();
    assert.equal(await run(['runs', 'nightly', '--json'], json), 0);
    const firedAt = JSON.parse(json.stdout()).runs[0].firedAt;

    const paths = runLogPaths(w.logDir, 'nightly', firedAt);
    fs.mkdirSync(path.dirname(paths.log), { recursive: true });
    fs.writeFileSync(paths.log, 'working…\ndone\n');
    const log = capture();
    assert.equal(await run(['log', 'nightly', String(firedAt)], log), 0);
    assert.match(log.stdout(), /done/);

    assert.equal(await run(['kill', 'nightly', String(firedAt)], capture()), 0);
    assert.equal(await run(['delete', 'nightly'], capture()), 0);
    assert.equal(await run(['list'], capture()), 0);
  } finally {
    await w.api.close();
  }
});

// ---------- the Content-Length discipline (the internal API's 411) ----------

test('client layer: body-carrying requests declare Content-Length; bodyless stay bodyless', async () => {
  const sock = path.join(fs.mkdtempSync(path.join(dir, 'rec-')), 'webpi.sock');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      cl: req.headers['content-length'] ?? null,
      te: req.headers['transfer-encoding'] ?? null,
      ct: req.headers['content-type'] ?? null,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(sock, resolve));
  try {
    const body = JSON.stringify({ name: 'nightly', schedule: '0 4 * * *', command: 'echo hi' });
    await internalRequest(sock, 'POST', '/jobs', body); // create/set/validate
    await internalRequest(sock, 'POST', '/jobs/nightly/run'); // run/kill: no body
    await internalRequest(sock, 'PATCH', '/jobs/nightly', body); // PATCH carries one too
    await internalRequest(sock, 'GET', '/jobs'); // list/runs: no body
    assert.deepEqual(seen[0], {
      method: 'POST',
      cl: String(Buffer.byteLength(body)),
      te: null,
      ct: 'application/json',
    });
    assert.deepEqual(seen[1], { method: 'POST', cl: '0', te: null, ct: null });
    assert.deepEqual(seen[2], {
      method: 'PATCH',
      cl: String(Buffer.byteLength(body)),
      te: null,
      ct: 'application/json',
    });
    assert.deepEqual(seen[3], { method: 'GET', cl: null, te: null, ct: null });
    // no request ever leaves chunked framing on — the internal API's 411
    // can only strike a body-carrying request without a length, and the
    // booted-API tests above show those all reach the server (exit 0).
  } finally {
    server.close();
  }
});

// ---------- bin-level behavior the in-process layer can't see ----------

test('bin: argv → exit code wiring, and the shebang entry runs unaided', () => {
  const r = bin(['--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /webpi — the web-pi command line/);

  const bad = bin(['jobs', 'nope'], {});
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown jobs verb/);
});
