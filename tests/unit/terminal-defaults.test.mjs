// terminal-defaults.test.mjs — the resolution chains (task/defaults-settings,
// src/lib/terminal-defaults.ts): db override → env → built-in for both the
// shell and the agent command, the whitespace split, and the save family's
// every error code (database_error). The env side is pinned by importing
// AFTER process.env is set (node:test runs each file in its own process —
// RAW_ENV is computed once, at env.ts's module load), and the agent's
// built-in pi fallback is the pure defaultAgentCommand (env.ts — the fs
// probe injected, like internalSocketDefault). Runs against dist-server.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENV_AGENT = '/from/env/agent --flag';
const ENV_SHELL = '/from/env/shell -l';
process.env.CYBERMOLE_AGENT_COMMAND = ENV_AGENT;
process.env.CYBERMOLE_COMMAND = ENV_SHELL;

const { StateDb } = await import('../../dist-server/src/lib/db.js');
const {
  resolveCommand,
  splitCommandLine,
  resolvedAgentCommand,
  resolvedShellCommand,
  terminalDefaults,
  saveTerminalDefaults,
} = await import('../../dist-server/src/lib/terminal-defaults.js');
const { defaultAgentCommand, PI_BIN } = await import('../../dist-server/src/lib/env.js');

function freshDb() {
  return new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-td-')), 'cybermole.db'),
  );
}

function brokenDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-td-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new StateDb(path.join(file, 'cybermole.db'));
}

// ---------- the pure chain ----------

test('resolveCommand: a stored override wins, else the env value', () => {
  assert.equal(resolveCommand(null, ENV_SHELL), ENV_SHELL);
  assert.equal(resolveCommand('/db/override', ENV_SHELL), '/db/override');
  // the env value is the chain's tail — it already carries the built-in
  assert.equal(resolveCommand(null, 'pi'), 'pi');
});

test('splitCommandLine: the spawner semantics, identical to the old CYBERMOLE_COMMAND split', () => {
  assert.deepEqual(splitCommandLine('zsh -l'), ['zsh', '-l']);
  assert.deepEqual(splitCommandLine('  /bin/sh   -l  '), ['/bin/sh', '-l']);
  assert.deepEqual(splitCommandLine('/path/with no spaces yet single arg'), [
    '/path/with',
    'no',
    'spaces',
    'yet',
    'single',
    'arg',
  ]);
  assert.deepEqual(splitCommandLine(''), []);
  assert.deepEqual(splitCommandLine('   '), []);
});

test("defaultAgentCommand (env.ts): the vendored pi binary when the install has one, else 'pi' on PATH", () => {
  assert.equal(defaultAgentCommand('/app/node_modules/.bin/pi', true), '/app/node_modules/.bin/pi');
  assert.equal(defaultAgentCommand('/app/node_modules/.bin/pi', false), 'pi');
  // this repo vendors pi, so the shipped built-in is the absolute PI_BIN
  if (fs.existsSync(PI_BIN))
    assert.equal(defaultAgentCommand(PI_BIN, fs.existsSync(PI_BIN)), PI_BIN);
});

// ---------- the db-backed chain (env pinned above) ----------

test('terminalDefaults / resolved*: unset db → the env values, no overrides flagged', () => {
  const db = freshDb();
  const d = terminalDefaults(db);
  assert.equal(d.ok, true, d.errorMessage);
  assert.deepEqual(d.data, {
    agentCommand: ENV_AGENT,
    shellCommand: ENV_SHELL,
    agentOverridden: false,
    shellOverridden: false,
  });
  assert.equal(resolvedAgentCommand(db).data.value, ENV_AGENT);
  assert.equal(resolvedShellCommand(db).data.value, ENV_SHELL);
});

test('resolved*: a db override wins over the env value (the whole point)', async () => {
  const db = freshDb();
  assert.equal((await saveTerminalDefaults(db, { agentCommand: '/db/agent -x' })).ok, true);
  assert.equal((await saveTerminalDefaults(db, { shellCommand: '/db/shell -y' })).ok, true);
  assert.equal(resolvedAgentCommand(db).data.value, '/db/agent -x');
  assert.equal(resolvedShellCommand(db).data.value, '/db/shell -y');
  const d = terminalDefaults(db).data;
  assert.deepEqual(
    [d.agentCommand, d.shellCommand, d.agentOverridden, d.shellOverridden],
    ['/db/agent -x', '/db/shell -y', true, true],
  );
});

test('saveTerminalDefaults: null clears back to the env chain, absent keeps, the answer is the effective pair', async () => {
  const db = freshDb();
  // absent keeps: a one-field save leaves the other untouched
  const onlyAgent = await saveTerminalDefaults(db, { agentCommand: '/db/agent' });
  assert.equal(onlyAgent.ok, true);
  assert.deepEqual(onlyAgent.data, {
    agentCommand: '/db/agent',
    shellCommand: ENV_SHELL,
    agentOverridden: true,
    shellOverridden: false,
  });
  // null clears: the override row is GONE (unset), not an empty string
  await saveTerminalDefaults(db, { shellCommand: '/db/shell' });
  const cleared = await saveTerminalDefaults(db, { shellCommand: null });
  assert.deepEqual(cleared.data, {
    agentCommand: '/db/agent',
    shellCommand: ENV_SHELL,
    agentOverridden: true,
    shellOverridden: false,
  });
  // clearing an unset override is a no-op that still succeeds
  assert.equal((await saveTerminalDefaults(db, { shellCommand: null })).ok, true);
});

test('a corrupt settings row reads as unset (data we wrote, never a db failure)', async () => {
  const db = freshDb();
  await saveTerminalDefaults(db, { agentCommand: '/db/agent' });
  db.setSetting('terminalDefaults.agentCommand', 'not json');
  db.setSetting('terminalDefaults.shellCommand', '42'); // JSON, but not a string
  const d = terminalDefaults(db);
  assert.equal(d.ok, true, d.errorMessage);
  assert.deepEqual(d.data, {
    agentCommand: ENV_AGENT,
    shellCommand: ENV_SHELL,
    agentOverridden: false,
    shellOverridden: false,
  });
});

// ---------- the families' every error code ----------

test('terminal_defaults / save_terminal_defaults: database_error on an unreadable db', async () => {
  assert.equal(terminalDefaults(brokenDb()).errorCode, 'database_error');
  assert.equal(terminalDefaults(brokenDb()).resultType, 'terminal_defaults');
  const saved = await saveTerminalDefaults(brokenDb(), { agentCommand: 'x' });
  assert.equal(saved.ok, false);
  assert.equal(saved.resultType, 'save_terminal_defaults');
  assert.equal(saved.errorCode, 'database_error');
  const cleared = await saveTerminalDefaults(brokenDb(), { shellCommand: null });
  assert.equal(cleared.errorCode, 'database_error');
});
