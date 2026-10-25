// The command resolution chains (db override → env → built-in), the
// whitespace split, and the save family's error code. process.env is set
// before the import, since RAW_ENV is read at env.ts's load.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENV_AGENT = '/from/env/agent --flag';
const ENV_SHELL = '/from/env/shell -l';
process.env.CYBERMOLE_AGENT_COMMAND = ENV_AGENT;
process.env.CYBERMOLE_COMMAND = ENV_SHELL;

const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');
const {
  resolveCommand,
  splitCommandLine,
  resolvedAgentCommand,
  resolvedShellCommand,
  terminalDefaults,
  saveTerminalDefaults,
} = await import('../../dist-server/src/lib/terminals/terminal-defaults.js');
const { defaultAgentCommand, PI_BIN } = await import('../../dist-server/src/lib/platform/env.js');

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

// ---------- pure chain ----------

test('resolveCommand: a stored override wins, else the env value', () => {
  assert.equal(resolveCommand(null, ENV_SHELL), ENV_SHELL);
  assert.equal(resolveCommand('/db/override', ENV_SHELL), '/db/override');
  // the env value is the tail and already carries the built-in
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
  // this repo vendors pi, so the built-in is the absolute PI_BIN
  if (fs.existsSync(PI_BIN))
    assert.equal(defaultAgentCommand(PI_BIN, fs.existsSync(PI_BIN)), PI_BIN);
});

// ---------- db-backed chain ----------

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
  assert.equal(saveTerminalDefaults(db, { agentCommand: '/db/agent -x' }).ok, true);
  assert.equal(saveTerminalDefaults(db, { shellCommand: '/db/shell -y' }).ok, true);
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
  // absent keeps
  const onlyAgent = saveTerminalDefaults(db, { agentCommand: '/db/agent' });
  assert.equal(onlyAgent.ok, true);
  assert.deepEqual(onlyAgent.data, {
    agentCommand: '/db/agent',
    shellCommand: ENV_SHELL,
    agentOverridden: true,
    shellOverridden: false,
  });
  // null deletes the row, rather than storing ''
  saveTerminalDefaults(db, { shellCommand: '/db/shell' });
  const cleared = saveTerminalDefaults(db, { shellCommand: null });
  assert.deepEqual(cleared.data, {
    agentCommand: '/db/agent',
    shellCommand: ENV_SHELL,
    agentOverridden: true,
    shellOverridden: false,
  });
  // clearing an unset override still succeeds
  assert.equal(saveTerminalDefaults(db, { shellCommand: null }).ok, true);
});

test('a corrupt settings row reads as unset (data we wrote, never a db failure)', async () => {
  const db = freshDb();
  saveTerminalDefaults(db, { agentCommand: '/db/agent' });
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

// ---------- error codes ----------

test('terminal_defaults / save_terminal_defaults: database_error on an unreadable db', async () => {
  assert.equal(terminalDefaults(brokenDb()).errorCode, 'database_error');
  assert.equal(terminalDefaults(brokenDb()).resultType, 'terminal_defaults');
  const saved = saveTerminalDefaults(brokenDb(), { agentCommand: 'x' });
  assert.equal(saved.ok, false);
  assert.equal(saved.resultType, 'save_terminal_defaults');
  assert.equal(saved.errorCode, 'database_error');
  const cleared = saveTerminalDefaults(brokenDb(), { shellCommand: null });
  assert.equal(cleared.errorCode, 'database_error');
});
