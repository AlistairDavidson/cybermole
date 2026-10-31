// The app host supervisor with spawn, clocks and logger injected: spawn
// args and env, child log lines re-logged at their level, crash restarts
// with doubling backoff and the stable-run reset, stop()'s SIGTERM handshake,
// SIGKILL after the grace, and stop() cancelling a pending restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { startAppHostSupervisor } =
  await import('../../dist-server/src/lib/apps/app-host-supervisor.js');

function fakeLogger() {
  const lines = [];
  return {
    lines,
    info: m => lines.push(['info', m]),
    warn: m => lines.push(['warn', m]),
    error: m => lines.push(['error', m]),
  };
}

/** kill only records signals (SIGKILL auto-exits); the test fires exit(). */
function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kills = [];
  c.kill = signal => {
    c.kills.push(signal ?? 'SIGTERM');
    if ((signal ?? 'SIGTERM') === 'SIGKILL') c.emit('exit', null, 'SIGKILL');
  };
  return c;
}

function harness(deps = {}) {
  const log = fakeLogger();
  const spawns = []; // { at, command, args, env, child }
  const spawnFn = (command, args, options) => {
    const child = fakeChild(4000 + spawns.length);
    spawns.push({ at: Date.now(), command, args, env: options.env, child });
    return child;
  };
  const handle = startAppHostSupervisor({
    command: 'node',
    args: ['/opt/cybermole/dist-server/server/app-host.js'],
    env: { CYBERMOLE_HOME: '/workspace' },
    log,
    spawn: spawnFn,
    restartDelayMs: 10,
    backoffCapMs: 1000,
    stableMs: 10_000,
    killGraceMs: 5000,
    ...deps,
  });
  return { handle, log, spawns };
}

/** stop(), plus the exit a real child would send on SIGTERM. */
async function stopWithExit(handle, spawns) {
  const stopped = handle.stop();
  spawns[spawns.length - 1].child.emit('exit', 0, 'SIGTERM');
  await stopped;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('spawns the host once at start: command, args, env verbatim; a boot line is logged', () => {
  const { handle, log, spawns } = harness();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, 'node');
  assert.equal(spawns[0].args[0], '/opt/cybermole/dist-server/server/app-host.js');
  assert.equal(spawns[0].env.CYBERMOLE_HOME, '/workspace');
  assert.equal(handle.starts, 1);
  assert.equal(handle.pid, 4000);
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'info' && m.includes('app host started')));
});

test('child stdout/stderr lines re-logged level-parsed, the winston prefix stripped', () => {
  const { log, spawns } = harness();
  const c = spawns[0].child;
  c.stdout.emit(
    'data',
    Buffer.from('2026-10-24T10:00:00.000Z info  [app-host] app host listening on /run/apps.sock\n'),
  );
  c.stderr.emit(
    'data',
    Buffer.from('2026-10-24T10:00:01.000Z error [app-host] discovery failed\n'),
  );
  // A partial line waits for its newline; a non-winston line forwards verbatim.
  c.stdout.emit('data', Buffer.from('half a '));
  c.stdout.emit('data', Buffer.from('line\nplain line\n'));
  assert.deepEqual(log.lines.slice(1), [
    ['info', 'app host listening on /run/apps.sock'],
    ['error', 'discovery failed'],
    ['info', 'half a line'],
    ['info', 'plain line'],
  ]);
});

test('a crashed child restarts with doubling backoff (gaps ≈ 10ms, 20ms, 40ms)', async () => {
  const { handle, spawns } = harness();
  // Three quick crashes; the gaps between spawns are the delays.
  spawns[0].child.emit('exit', 1, null);
  await sleep(25);
  spawns[1].child.emit('exit', 1, null);
  await sleep(45);
  spawns[2].child.emit('exit', 1, null);
  await sleep(85);
  assert.equal(handle.starts, 4);
  const gap1 = spawns[1].at - spawns[0].at;
  const gap2 = spawns[2].at - spawns[1].at;
  const gap3 = spawns[3].at - spawns[2].at;
  assert.ok(gap1 >= 10 && gap1 < 20, `gap1 ${gap1}`);
  assert.ok(gap2 >= 20 && gap2 < 40, `gap2 ${gap2}`);
  assert.ok(gap3 >= 40 && gap3 < 80, `gap3 ${gap3}`);
  await stopWithExit(handle, spawns);
});

test('a stable run resets the backoff: after living ≥ stableMs, the next crash waits the base delay', async () => {
  const { handle, spawns } = harness({ restartDelayMs: 10, stableMs: 60 });
  // One quick crash doubles the delay (10 → 20)…
  spawns[0].child.emit('exit', 1, null);
  await sleep(30);
  assert.equal(handle.starts, 2);
  // …then a child lives long enough to count as stable.
  await sleep(70);
  spawns[1].child.emit('exit', 1, null);
  await sleep(19); // base delay 10 would fire by now; the doubled 40 would not
  assert.equal(handle.starts, 3, 'the restart came at the BASE delay');
  await stopWithExit(handle, spawns);
});

test('stop(): SIGTERM to the live child, resolves on its exit, never restarts; idempotent', async () => {
  const { handle, log, spawns } = harness();
  const stopped = handle.stop();
  assert.equal(spawns[0].child.kills[0], 'SIGTERM');
  spawns[0].child.emit('exit', 0, 'SIGTERM');
  await stopped;
  await sleep(40); // a restart would have fired in here
  assert.equal(handle.starts, 1, 'no restart after stop');
  assert.equal(handle.pid, null);
  await handle.stop(); // idempotent, resolves immediately
  assert.ok(log.lines.every(([, m]) => !m.includes('restarting')));
});

test('stop() SIGKILLs a child that ignores SIGTERM, after the grace', async () => {
  const { handle, spawns } = harness({ killGraceMs: 40 });
  const stopped = handle.stop();
  await sleep(15);
  assert.equal(spawns[0].child.kills.length, 1, 'only SIGTERM so far');
  await stopped;
  assert.deepEqual(spawns[0].child.kills, ['SIGTERM', 'SIGKILL']);
});

test('a restart scheduled before stop() is cancelled', async () => {
  const { handle, spawns } = harness();
  spawns[0].child.emit('exit', 1, null); // schedules a restart in 10ms
  await handle.stop();
  await sleep(40);
  assert.equal(handle.starts, 1, 'the pending restart never ran');
});

test("a failed spawn ('error', never 'exit') is a death: logged, restarted with backoff, and stop() resolves", async () => {
  // A failed spawn emits 'error' but not 'exit'; it must count as a crash,
  // or nothing restarts and stop() waits forever.
  const { handle, log, spawns } = harness({ restartDelayMs: 15 });
  spawns[0].child.emit('error', new Error('spawn EMFILE'));
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'error' && m.includes('EMFILE')));
  assert.equal(handle.pid, null, 'the failed child is no longer current');
  await sleep(40); // the backoff restart fires (no exit event ever came)
  assert.equal(handle.starts, 2, 'the failed spawn restarted');
  // stop() resolves on the second child's exit.
  await stopWithExit(handle, spawns);
});

test('stop() resolves after a spawn failure with no live child and no pending restart', async () => {
  const { handle, spawns } = harness();
  spawns[0].child.emit('error', new Error('spawn ENOENT')); // death, no restart armed yet
  await handle.stop(); // resolves immediately: child === null, no timer
  await sleep(40);
  assert.equal(handle.starts, 1, 'no restart after stop');
});

test('name and downNote label the log lines (the editor rides the same loop)', async () => {
  const { handle, log, spawns } = harness({ name: 'editor', downNote: 'the editor tab 502s' });
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'info' && m === 'editor started (pid 4000)'));
  spawns[0].child.emit('exit', 1, null);
  assert.ok(
    log.lines.some(
      ([lvl, m]) =>
        lvl === 'warn' &&
        m.startsWith('editor (pid 4000) exited') &&
        m.endsWith('(the editor tab 502s)'),
    ),
  );
  await handle.stop();
});

test('beforeSpawn runs before every spawn; a throw is logged and the spawn still happens', async () => {
  let calls = 0;
  const { handle, log, spawns } = harness({
    beforeSpawn: () => {
      calls++;
      if (calls === 2) throw new Error('EACCES');
    },
  });
  assert.equal(calls, 1);
  spawns[0].child.emit('exit', 1, null);
  await sleep(25);
  assert.equal(calls, 2);
  assert.equal(handle.starts, 2, 'spawned despite the failed pre-step');
  assert.ok(
    log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('pre-spawn step failed: EACCES')),
  );
  await stopWithExit(handle, spawns);
});
