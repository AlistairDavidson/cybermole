// tmux.ts: -S vs -L socket selection, the never-fork guard's decisions, and
// against a real tmux server on an absolute socket: guarded new-session,
// the live-name set, the backfill capture, and umask inheritance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Set before the import: tmux.ts reads SOCKET at load, so everything below is split mode.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-tmux-test-'));
process.env.CYBERMOLE_TMUX_SOCKET = path.join(dir, 'tmux');

const {
  socketArgs,
  forksServer,
  isServerDown,
  SERVER_NOT_RUNNING_MSG,
  requireServer,
  newSession,
  newSessionArgs,
  hasSession,
  liveSessionNames,
  jobSessionName,
  terminalSessionName,
  capturePaneHistory,
  capturePaneHistoryArgs,
  BACKFILL_LINES,
  paneHistorySize,
} = await import('../../dist-server/src/lib/terminals/tmux.js');
const { TmuxSessionNameSchema } =
  await import('../../dist-server/packages/app-kit/src/schemas/ids.js');

const SOCKET = process.env.CYBERMOLE_TMUX_SOCKET;

const tmuxUp = () => {
  try {
    execFileSync('tmux', ['-S', SOCKET, 'show-options', '-g'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const haveTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('socketArgs: absolute path → -S, relative name → -L', () => {
  assert.deepEqual(socketArgs('/run/cybermole/tmux'), ['-S', '/run/cybermole/tmux']);
  assert.deepEqual(socketArgs('cybermole'), ['-L', 'cybermole']);
  assert.deepEqual(socketArgs('cybermole-itest'), ['-L', 'cybermole-itest']);
});

test('forksServer: only relative names keep fork-to-start (the guard gate)', () => {
  assert.equal(forksServer('cybermole'), true); // single-user: first new-session forks the server
  assert.equal(forksServer('/run/cybermole/tmux'), false); // split: another uid owns the server
  assert.equal(forksServer('/'), false);
});

test('isServerDown: down-server errors, an answering server, unknown failures', () => {
  const err = stderr => Object.assign(new Error('tmux failed'), { stderr });
  // No socket file, or a stale one: both down.
  assert.equal(
    isServerDown(err(`error connecting to ${SOCKET} (No such file or directory)`)),
    true,
  );
  assert.equal(isServerDown(err(`no server running on ${SOCKET}`)), true);
  // The one error a live server gives list-sessions.
  assert.equal(isServerDown(err('no sessions')), false);
  assert.equal(isServerDown(null), false);
  // Anything unreadable reads as down: refusing is always safe.
  assert.equal(isServerDown(err('')), true);
  assert.equal(isServerDown(err(`error connecting to ${SOCKET} (Permission denied)`)), true);
  assert.equal(
    isServerDown(Object.assign(new Error('x'), { stderr: Buffer.from('no server running on /x') })),
    true,
  );
});

test('jobSessionName: every valid job name yields a valid tmux session name (40-char names included)', () => {
  // 'cybermole-' + a 40-char job name = 46, inside the 64-char limit.
  for (const job of ['a', 'nightly-check', 'x'.repeat(40), 'a_b-c'.repeat(8)]) {
    assert.equal(TmuxSessionNameSchema.safeParse(jobSessionName(job)).success, true, job);
  }
});

// ---------- terminal-tab sessions ----------

test('terminalSessionName: t-<uuid> for every terminal row id — always a valid session name', () => {
  for (const id of [
    '123e4567-e89b-42d3-a456-426614174000',
    '019f4706-0000-7000-8000-00000000abcd',
  ]) {
    const name = terminalSessionName(id);
    assert.equal(name, `t-${id}`);
    assert.equal(name.length, 38, "'t-' + a 36-char uuid");
    assert.equal(TmuxSessionNameSchema.safeParse(name).success, true, name);
  }
});

test('newSessionArgs: detached, named, at the cwd, -e env pairs, command after -- (the spawn/respawn argv)', () => {
  // Shared by spawn and respawn. '--' keeps command flags from reaching
  // tmux; env rides -e so it doesn't depend on when the server started.
  assert.deepEqual(
    newSessionArgs('t-123e4567-e89b-42d3-a456-426614174000', '/workspace', ['/bin/sh', '-l'], {
      HOME: '/home/u',
      PI_CODING_AGENT_DIR: '/state/pi-agent',
    }),
    [
      'new-session',
      '-d',
      '-s',
      't-123e4567-e89b-42d3-a456-426614174000',
      '-c',
      '/workspace',
      '-e',
      'HOME=/home/u',
      '-e',
      'PI_CODING_AGENT_DIR=/state/pi-agent',
      '--',
      '/bin/sh',
      '-l',
    ],
  );
  // no env → no -e pairs; the command stays last
  assert.deepEqual(newSessionArgs('t-x', '/w', ['/bin/sh', '-c', 'echo hi'], {}), [
    'new-session',
    '-d',
    '-s',
    't-x',
    '-c',
    '/w',
    '--',
    '/bin/sh',
    '-c',
    'echo hi',
  ]);
});

// ---------- attach backfill capture ----------

test('capturePaneHistoryArgs: plain text, history capped at BACKFILL_LINES, screen EXCLUDED (-E -1)', () => {
  // Stops at the last history line, so it never duplicates the screen the redraw paints.
  assert.equal(BACKFILL_LINES, 5000);
  assert.deepEqual(capturePaneHistoryArgs('t-123e4567-e89b-42d3-a456-426614174000'), [
    'capture-pane',
    '-p',
    '-S',
    '-5000',
    '-E',
    '-1',
    '-t',
    't-123e4567-e89b-42d3-a456-426614174000',
  ]);
});

// ---------- real tmux, absolute socket ----------

/** As the workspace entrypoint does: exit-empty off in the -f conf (a
 *  separate set-option races the empty server's exit). */
function startServer() {
  // The previous test's kill-server returns before the socket is unlinked;
  // starting in that window hits "server exited unexpectedly". Wait, then
  // remove the file if it's a stale leftover.
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 500 && fs.existsSync(SOCKET); i += 1) sleep(10);
  if (fs.existsSync(SOCKET)) fs.rmSync(SOCKET, { force: true });
  const conf = path.join(dir, 'server.conf');
  fs.writeFileSync(conf, 'set -g exit-empty off\n');
  execFileSync('tmux', ['-S', SOCKET, '-f', conf, 'start-server']);
  // tmux creates the socket 0600 regardless of umask; the entrypoint chmods it.
  fs.chmodSync(SOCKET, 0o660);
}

test(
  'requireServer (the guard runner, absolute socket): refuses while down, passes once a server answers',
  { skip: !haveTmux },
  async () => {
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
  },
);

test(
  'never-fork guard: no server → clear error, and NO server gets forked',
  { skip: !haveTmux },
  async () => {
    assert.equal(tmuxUp(), false);
    assert.equal(fs.existsSync(SOCKET), false);
    const refused = await newSession('guardtest', dir, ['/bin/sh', '-c', 'true'], {});
    assert.equal(refused.ok, false, 'newSession must fail');
    assert.equal(refused.errorCode, 'server_not_running');
    assert.ok(refused.errorMessage.startsWith(SERVER_NOT_RUNNING_MSG), refused.errorMessage);
    assert.equal(fs.existsSync(SOCKET), false, 'must not fork a tmux server as the web uid');
  },
);

test(
  'guarded create works once the workspace side owns a live server',
  { skip: !haveTmux },
  async () => {
    startServer();
    assert.equal(tmuxUp(), true);
    const marker = path.join(dir, 'marker.txt');
    const created = await newSession(
      'live1',
      dir,
      ['/bin/sh', '-c', `echo ok > ${JSON.stringify(marker)}; sleep 5`],
      {},
    );
    assert.deepEqual(created, { ok: true, resultType: 'tmux_session', data: { name: 'live1' } });
    assert.equal(await hasSession('live1'), true);
    const names = await liveSessionNames();
    assert.ok(names.has('live1'));
    // A taken name is tmux's failure (tmux_error), not the guard's.
    const dup = await newSession('live1', dir, ['/bin/sh', '-c', 'true'], {});
    assert.equal(dup.ok, false);
    assert.equal(dup.errorCode, 'tmux_error');
    // -e env through the guarded path.
    const envfile = path.join(dir, 'env.txt');
    const created2 = await newSession(
      'live2',
      dir,
      ['/bin/sh', '-c', `echo $SPLIT_PROBE > ${JSON.stringify(envfile)}; sleep 5`],
      { SPLIT_PROBE: 'delivered' },
    );
    assert.equal(created2.ok, true);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(fs.readFileSync(envfile, 'utf8').trim(), 'delivered');
  },
);

test(
  'capturePaneHistory (real tmux): history only, trailing blanks trimmed, dead session / empty history → null',
  { skip: !haveTmux },
  async () => {
    try {
      execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
    fs.rmSync(SOCKET, { force: true });
    startServer();
    try {
      // 40 lines on a 10-row pane: 31+ in history, the rest on screen.
      const made = await newSession('captest', dir, ['/bin/sh', '-c', 'seq 1 40; sleep 30'], {});
      assert.equal(made.ok, true);
      await new Promise(r => setTimeout(r, 500));
      const full = execFileSync('tmux', [
        '-S',
        SOCKET,
        'capture-pane',
        '-p',
        '-S',
        '-5000',
        '-t',
        'captest',
      ]).toString();
      const history = await capturePaneHistory('captest');
      assert.ok(history !== null, 'history must capture');
      // \r\n endings (a bare \n drifts the column), one trailing newline
      assert.ok(history.endsWith('\r\n'), 'line-per-\\r\\n shape');
      assert.equal(/\r\n[ \t]*\r\n$/.test(history), false, 'trailing blank lines trimmed');
      // History only: a strict line-aligned prefix of the full capture.
      const fullLines = full.split('\n');
      const histLines = history.slice(0, -2).split('\r\n');
      assert.ok(
        histLines.length >= 1 && histLines.length < fullLines.length,
        `history (${histLines.length}) must be shorter than history+screen (${fullLines.length})`,
      );
      assert.deepEqual(fullLines.slice(0, histLines.length), histLines);
      // dead session: null, never a throw
      assert.equal(await capturePaneHistory('captest-nope'), null);
      // empty history: null
      const fresh = await newSession('capfresh', dir, ['/bin/sh', '-c', 'sleep 30'], {});
      assert.equal(fresh.ok, true);
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await capturePaneHistory('capfresh'), null);
      // With no history, -E -1 clamps to the first screen line; the
      // history_size check makes it null instead.
      const banner = await newSession(
        'capbanner',
        dir,
        ['/bin/sh', '-c', 'echo QUIRK_BANNER; sleep 30'],
        {},
      );
      assert.equal(banner.ok, true);
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await paneHistorySize('capbanner'), 0, 'no history yet — nothing scrolled');
      assert.equal(
        await capturePaneHistory('capbanner'),
        null,
        'a screen-only pane must not backfill its first screen line',
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

test(
  'liveSessionNames: the name set the /api/state live diff reads',
  { skip: !haveTmux },
  async () => {
    // A down server reads as empty (clean slate first: the last test left one up).
    try {
      execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
    fs.rmSync(SOCKET, { force: true }); // a stale socket must not count either
    assert.equal((await liveSessionNames()).size, 0);
    startServer();
    try {
      const workdir = path.join(dir, 'live-probe');
      fs.mkdirSync(workdir, { recursive: true });
      const created = await newSession('liveprobe', workdir, ['/bin/sh', '-c', 'sleep 5'], {});
      assert.equal(created.ok, true);
      const names = await liveSessionNames();
      assert.ok(names.has('liveprobe'), `the session must be live: ${[...names]}`);
      execFileSync('tmux', ['-S', SOCKET, 'kill-session', '-t', 'liveprobe'], { stdio: 'ignore' });
    } finally {
      try {
        execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' });
      } catch {
        /* gone */
      }
    }
  },
);

test(
  'umask 0007 on the tmux server is inherited by what it spawns (group-readable session files)',
  { skip: !haveTmux },
  async () => {
    // The umask rides the server fork, so it must be set before start-server.
    const old = process.umask(0o007);
    startServer();
    try {
      const probe = path.join(dir, 'umask-probe.txt');
      await newSession(
        'umasktest',
        dir,
        ['/bin/sh', '-c', `touch ${JSON.stringify(probe)}; sleep 2`],
        {},
      );
      await new Promise(r => setTimeout(r, 500));
      assert.equal(
        fs.statSync(probe).mode & 0o777,
        0o660,
        'pane-spawned files must be group-rw under umask 0007',
      );
    } finally {
      process.umask(old);
      try {
        execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' });
      } catch {
        /* gone */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
