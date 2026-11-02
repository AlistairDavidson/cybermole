// session-hygiene.ts: which tmux sessions an install may kill (only its own
// stamped tab sessions: orphans always, stale ones at boot), and the pi
// agent tab's stable session id (terminal-defaults.ts agentTabArgv).
import test from 'node:test';
import assert from 'node:assert/strict';

const { planSessionHygiene, sessionGeneration, sessionStamp } =
  await import('../../dist-server/src/lib/terminals/session-hygiene.js');
const { agentTabArgv } = await import('../../dist-server/src/lib/terminals/terminal-defaults.js');

const ID = n => `00000000-0000-4000-8000-00000000000${n}`;
const ME = 'instance-a';

test('planSessionHygiene: orphans and stale are only ever this instance’s stamped tab sessions', () => {
  const gen = 'gen-now';
  const sessions = new Map([
    [`t-${ID(1)}`, sessionStamp(ME, gen)], // current, has a row: kept
    [`t-${ID(2)}`, sessionStamp(ME, 'gen-old')], // has a row, old generation: stale
    [`t-${ID(3)}`, sessionStamp(ME, gen)], // no row: orphan
    [`t-${ID(4)}`, sessionStamp(ME, 'gen-old')], // no row and old: orphan (not stale)
    [`t-${ID(5)}`, sessionStamp('instance-b', gen)], // another install on the socket
    [`t-${ID(6)}`, null], // unstamped (pre-stamp, or the operator's)
    ['test', null], // a hand-made session
    ['cybermole-nightly', sessionStamp(ME, 'gen-old')], // our job run: never a tab
  ]);
  const plan = planSessionHygiene({
    sessions,
    instance: ME,
    generation: gen,
    terminalIds: new Set([ID(1), ID(2), ID(5), ID(6)]),
  });
  assert.deepEqual(plan.orphans, [`t-${ID(3)}`, `t-${ID(4)}`]);
  assert.deepEqual(plan.stale, [`t-${ID(2)}`]);
  assert.deepEqual(plan.foreign, [`t-${ID(5)}`, `t-${ID(6)}`, 'test']);
});

test('planSessionHygiene: an instance id that prefixes another is not a match', () => {
  const plan = planSessionHygiene({
    sessions: new Map([[`t-${ID(1)}`, sessionStamp(`${ME}-2`, 'g')]]),
    instance: ME,
    generation: 'g',
    terminalIds: new Set(),
  });
  assert.deepEqual(plan.orphans, []);
  assert.equal(plan.foreign.length, 1);
});

test('sessionGeneration: moves with the build or the env, not with key order', () => {
  const g = sessionGeneration('100', { A: '1', B: '2' });
  assert.equal(g, sessionGeneration('100', { B: '2', A: '1' }));
  assert.notEqual(g, sessionGeneration('101', { A: '1', B: '2' }));
  assert.notEqual(g, sessionGeneration('100', { A: '1', B: '3' }));
  assert.match(g, /^[0-9a-f]{12}$/);
});

test('agentTabArgv: a pi agent tab resumes one session by its terminal id; anything else runs as configured', () => {
  assert.deepEqual(agentTabArgv(['/opt/x/node_modules/.bin/pi'], ID(1)), [
    '/opt/x/node_modules/.bin/pi',
    '--session-id',
    ID(1),
  ]);
  assert.deepEqual(agentTabArgv(['pi', '--model', 'm'], ID(1)), [
    'pi',
    '--model',
    'm',
    '--session-id',
    ID(1),
  ]);
  // the configured command already picks its session
  for (const flag of ['-c', '--continue', '--session=x', '--no-session', '--resume'])
    assert.deepEqual(agentTabArgv(['pi', flag], ID(1)), ['pi', flag]);
  // not pi (a test double, another agent)
  assert.deepEqual(agentTabArgv(['/tmp/cmd.sh', 'agent'], ID(1)), ['/tmp/cmd.sh', 'agent']);
  assert.deepEqual(agentTabArgv(['pipx'], ID(1)), ['pipx']);
  assert.deepEqual(agentTabArgv([], ID(1)), []);
});
