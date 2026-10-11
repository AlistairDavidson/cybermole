// tmux.test.mjs — the privilege split's socket plumbing (src/lib/tmux.ts):
// -S-vs-L selection for WEB_PI_TMUX_SOCKET, the never-fork guard's
// decision table, and (where tmux exists — a stated requirement) the
// guarded new/resume behaviour against a real server on an absolute-path
// socket, plus the umask-0007 inheritance the split's group-sharing
// relies on. Run against the compiled output: `npm run test:unit`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Absolute-path socket BEFORE the first import: tmux.ts binds SOCKET at
// module load. Everything session-shaped below then runs in split mode.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-tmux-test-'));
process.env.WEB_PI_TMUX_SOCKET = path.join(dir, 'tmux');

const { socketArgs, forksServer, isServerDown, SERVER_NOT_RUNNING_MSG, requireServer,
        newSession, resumeSession, hasSession, liveSessionNames, jobSessionName, resumeSessionName,
        listSessions } =
  await import('../../dist-server/src/lib/tmux.js');
const { TmuxSessionNameSchema } = await import('../../dist-server/src/schemas/ids.js');

const SOCKET = process.env.WEB_PI_TMUX_SOCKET;

const tmuxUp = () => {
  try { execFileSync('tmux', ['-S', SOCKET, 'show-options', '-g'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const haveTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('socketArgs: absolute path → -S, relative name → -L', () => {
  assert.deepEqual(socketArgs('/run/web-pi/tmux'), ['-S', '/run/web-pi/tmux']);
  assert.deepEqual(socketArgs('web-pi'), ['-L', 'web-pi']);
  assert.deepEqual(socketArgs('web-pi-itest'), ['-L', 'web-pi-itest']);
});

test('forksServer: only relative names keep fork-to-start (the guard gate)', () => {
  assert.equal(forksServer('web-pi'), true);       // single-user: first new-session forks the server
  assert.equal(forksServer('/run/web-pi/tmux'), false); // split: another uid owns the server
  assert.equal(forksServer('/'), false);
});

test('isServerDown: down-server errors, an answering server, unknown failures', () => {
  const err = (stderr) => Object.assign(new Error('tmux failed'), { stderr });
  // No socket file / stale socket from a dead server — both mean DOWN.
  assert.equal(isServerDown(err(`error connecting to ${SOCKET} (No such file or directory)`)), true);
  assert.equal(isServerDown(err(`no server running on ${SOCKET}`)), true);
  // The one error an ALIVE server can answer list-sessions with.
  assert.equal(isServerDown(err('no sessions')), false);
  // The server answered fine.
  assert.equal(isServerDown(null), false);
  // Anything unreadable (timeout kill, permission denied on the socket)
  // reads as down: refusing is always safe, forking never is.
  assert.equal(isServerDown(err('')), true);
  assert.equal(isServerDown(err(`error connecting to ${SOCKET} (Permission denied)`)), true);
  assert.equal(isServerDown(Object.assign(new Error('x'), { stderr: Buffer.from('no server running on /x') })), true);
});

test('jobSessionName: every valid job name yields a valid tmux session name (40-char names included)', () => {
  // JOB_NAME_RE allows 40 chars; 'webpi-' + 40 = 46. The old 40-char tmux
  // name cap rejected these runs outright (newSession refused, hasSession
  // always false) — the brand now promises validity, this holds it to that.
  for (const job of ['a', 'nightly-check', 'x'.repeat(40), 'a_b-c'.repeat(8)]) {
    assert.equal(TmuxSessionNameSchema.safeParse(jobSessionName(job)).success, true, job);
  }
});

test('resumeSessionName: r-<full id>, hashed only when the id would not fit', () => {
  const id = '019f4706-0000-7000-8000-000000000001';
  assert.equal(resumeSessionName(id), `r-${id}`);
  const long = 'a'.repeat(64);
  const hashed = resumeSessionName(long);
  assert.match(hashed, /^r-[0-9a-f]{32}$/);
  assert.equal(TmuxSessionNameSchema.safeParse(hashed).success, true);
});

// ---------- functional (real tmux, absolute-path socket, split mode) ----------

/** Bring the server up the way the workspace entrypoint does: -f conf
 *  carrying exit-empty off (a separate `set-option` races the empty
 *  server's instant exit — the option must ride the server-start conf). */
function startServer() {
  const conf = path.join(dir, 'server.conf');
  fs.writeFileSync(conf, 'set -g exit-empty off\n');
  execFileSync('tmux', ['-S', SOCKET, '-f', conf, 'start-server']);
  // tmux hardcodes the socket 0600 at creation (umask ignored); the
  // workspace entrypoint chmod 0660's it — same here, single uid is
  // enough for the mechanics under test.
  fs.chmodSync(SOCKET, 0o660);
}

test('requireServer (the guard runner, absolute socket): refuses while down, passes once a server answers', { skip: !haveTmux }, async () => {
  // The export every guarded call site (new/resume/attach spawn) uses.
  assert.equal(fs.existsSync(SOCKET), false);
  const refused = await requireServer();
  assert.equal(refused.ok, false, 'must refuse');
  assert.equal(refused.errorCode, 'server_not_running');
  assert.ok(refused.errorMessage.startsWith(SERVER_NOT_RUNNING_MSG), refused.errorMessage);
  assert.equal(fs.existsSync(SOCKET), false, 'must not fork a tmux server');
  startServer();
  const ok = await requireServer();
  assert.equal(ok.ok, true);
  execFileSync('tmux', ['-S', SOCKET, 'kill-server']);
  fs.rmSync(SOCKET, { force: true }); // a lingering stale socket must not trip the next test
});

test('never-fork guard: no server → clear error, and NO server gets forked', { skip: !haveTmux }, async () => {
  assert.equal(tmuxUp(), false);
  assert.equal(fs.existsSync(SOCKET), false);
  const refused = await newSession('guardtest', dir, ['/bin/sh', '-c', 'true'], {});
  assert.equal(refused.ok, false, 'newSession must fail');
  assert.equal(refused.errorCode, 'server_not_running');
  assert.ok(refused.errorMessage.startsWith(SERVER_NOT_RUNNING_MSG), refused.errorMessage);
  assert.equal(fs.existsSync(SOCKET), false, 'must not fork a tmux server as the web uid');
});

test('guarded create works once the workspace side owns a live server', { skip: !haveTmux }, async () => {
  startServer();
  assert.equal(tmuxUp(), true);
  const marker = path.join(dir, 'marker.txt');
  const created = await newSession('live1', dir, ['/bin/sh', '-c', `echo ok > ${JSON.stringify(marker)}; sleep 5`], {});
  assert.deepEqual(created, { ok: true, resultType: 'tmux_session', data: { name: 'live1' } });
  // The session really runs on the shared socket.
  assert.equal(await hasSession('live1'), true);
  const names = await liveSessionNames();
  assert.ok(names.has('live1'));
  // A taken name is tmux's own failure — tmux_error, not the guard.
  const dup = await newSession('live1', dir, ['/bin/sh', '-c', 'true'], {});
  assert.equal(dup.ok, false);
  assert.equal(dup.errorCode, 'tmux_error');
  // -e env delivery through the guarded path.
  const envfile = path.join(dir, 'env.txt');
  const created2 = await newSession('live2', dir, ['/bin/sh', '-c', `echo $SPLIT_PROBE > ${JSON.stringify(envfile)}; sleep 5`],
    { SPLIT_PROBE: 'delivered' });
  assert.equal(created2.ok, true);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fs.readFileSync(envfile, 'utf8').trim(), 'delivered');
});

test('resume path: reuse when the session exists, guard when the server is down', { skip: !haveTmux }, async () => {
  // Existing resume session → no create, no error.
  const reused = await resumeSession('live1', dir, ['/bin/sh'], '019f4706-0000-7000-8000-000000000009', {});
  assert.equal(reused.ok, true);
  execFileSync('tmux', ['-S', SOCKET, 'kill-server']);
  assert.equal(tmuxUp(), false);
  // Server down → the resume-create branch hits the same guard.
  const refused = await resumeSession('r-019f4706-0000-7000-8000-000000000010', dir, ['/bin/sh'],
    '019f4706-0000-7000-8000-000000000010', {});
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, 'server_not_running');
  assert.ok(refused.errorMessage.startsWith(SERVER_NOT_RUNNING_MSG), refused.errorMessage);
});

test('listSessions: explicit -F rows with the pane cwd (current, else the spawn dir)', { skip: !haveTmux }, async () => {
  // The sidebar's "open in Zed" reads LiveSession.cwd: #{pane_current_path},
  // falling back to #{pane_start_path} (tmux resolves current via the pane
  // tty's foreground pgrp; a normal kernel sets it when the pane process
  // takes the tty, some pty layers never do — the fallback then yields the
  // `-c` spawn dir, which newSession sets to the session's cwd either way).
  startServer();
  try {
    const workdir = path.join(dir, 'cwd-probe');
    fs.mkdirSync(workdir, { recursive: true });
    const created = await newSession('listprobe', workdir, ['/bin/sh', '-c', 'sleep 5'], {});
    assert.equal(created.ok, true);
    const live = await listSessions();
    const row = live.find(s => s.name === 'listprobe');
    assert.ok(row, `the session must be listed: ${JSON.stringify(live)}`);
    assert.equal(row.socket, SOCKET);
    assert.equal(row.windows, 1);
    assert.equal(row.attached, false);
    assert.equal(row.cwd, workdir); // current when resolvable, else the -c spawn dir
    assert.match(row.created, /\d{4}/, 'the epoch is formatted in JS, not raw');
    execFileSync('tmux', ['-S', SOCKET, 'kill-session', '-t', 'listprobe'], { stdio: 'ignore' });
  } finally {
    try { execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
  }
});

test('umask 0007 on the tmux server is inherited by what it spawns (group-readable session files)', { skip: !haveTmux }, async () => {
  // The mechanism the split's sharing relies on (sidebar reads pi's
  // session store from the web side): the umask rides the server fork,
  // so it must be in place BEFORE start-server.
  const old = process.umask(0o007);
  startServer();
  try {
    const probe = path.join(dir, 'umask-probe.txt');
    await newSession('umasktest', dir, ['/bin/sh', '-c', `touch ${JSON.stringify(probe)}; sleep 2`], {});
    await new Promise(r => setTimeout(r, 500));
    assert.equal(fs.statSync(probe).mode & 0o777, 0o660,
      'pane-spawned files must be group-rw under umask 0007');
  } finally {
    process.umask(old);
    try { execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
