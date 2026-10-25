// app-host-supervisor.test.mjs — task/app-web (apps-plan §3) units: the
// single-user spawn rule's supervisor, with the spawn function, clocks
// and logger all injected (no real children). Covers: the initial
// spawn's command/args/env, child log lines re-logged level-parsed with
// the winston prefix stripped, crash → restart with doubling backoff
// (measured as the gaps between spawns), the stable-run reset, stop()'s
// SIGTERM→exit handshake (idempotent, no restart after), SIGKILL after
// the grace for a child that ignores SIGTERM, and a pending restart
// timer cancelled by stop().
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

/** A fake ChildProcess: an EventEmitter with the surface the supervisor
 *  touches. exit() is fired by the test (a real SIGTERM-ignoring child
 *  just never exits — kill only RECORDS signals; SIGKILL auto-exits). */
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

/** stop() + the exit the real child would send on SIGTERM (the fake's
 *  kill only records signals — the test fires the exit by hand). */
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
  // Kill quickly three times; the gaps between spawns are the delays.
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
  // One quick crash to double the delay (10 → 20)…
  spawns[0].child.emit('exit', 1, null);
  await sleep(30);
  assert.equal(handle.starts, 2);
  // …then a child that lives long enough to count as stable.
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
  // Node emits 'error' (+'close') but NOT 'exit' when spawn() itself fails
  // (EMFILE, ENOENT) — the supervisor must treat it like a crash, or it
  // would never restart and a later stop() would wedge on the exit that
  // never comes.
  const { handle, log, spawns } = harness({ restartDelayMs: 15 });
  spawns[0].child.emit('error', new Error('spawn EMFILE'));
  assert.ok(log.lines.some(([lvl, m]) => lvl === 'error' && m.includes('EMFILE')));
  assert.equal(handle.pid, null, 'the failed child is no longer current');
  await sleep(40); // the backoff restart fires (no exit event ever came)
  assert.equal(handle.starts, 2, 'the failed spawn restarted');
  // And stop() resolves on the SECOND child's real exit — no wedge.
  await stopWithExit(handle, spawns);
});

test('stop() resolves after a spawn failure with no live child and no pending restart', async () => {
  const { handle, spawns } = harness();
  spawns[0].child.emit('error', new Error('spawn ENOENT')); // death, no restart armed yet
  await handle.stop(); // resolves immediately: child === null, no timer
  await sleep(40);
  assert.equal(handle.starts, 1, 'no restart after stop');
});
