// workspaces.ts: every Result family at every error code, the attach lookup,
// the tree read with its live diff, cascade deletes and best-effort kills.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb, qb } from '../../dist-server/src/lib/platform/db.js';
import { Workspaces } from '../../dist-server/src/lib/terminals/workspaces.js';
import { Apps } from '../../dist-server/src/lib/apps/apps.js';
import {
  terminalSessionName,
  SERVER_NOT_RUNNING_MSG,
} from '../../dist-server/src/lib/terminals/tmux.js';
import { UUID_RE } from '../../dist-server/packages/app-kit/src/schemas/patterns.js';
import {
  WorkspaceIdSchema,
  TerminalIdSchema,
} from '../../dist-server/packages/app-kit/src/schemas/ids.js';

const USERNAME = { ok: true, resultType: 'database_read', data: { value: 'tester' } };
const USERNAME_FAIL = {
  ok: false,
  resultType: 'database_read',
  errorCode: 'database_error',
  errorMessage: 'could not read the credential',
};
const MISSING_WS = '99999999-9999-4999-8999-999999999999'; // a well-formed uuid v4 that is not ours

function freshDb() {
  return new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-ws-')), 'cybermole.db'),
  );
}

function brokenDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-ws-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new StateDb(path.join(file, 'cybermole.db'));
}

function recorder() {
  const killed = [];
  return { killed, killSession: async name => (killed.push(name), true) };
}

/** Records (name, cwd, command, env); the commands tell the auto-opened
 *  agent tab from + tabs. */
function spawner() {
  const spawned = [];
  return {
    spawned,
    spawnSession: async (name, cwd, command, env) => {
      spawned.push({ name, cwd, command, env });
      return { ok: true, resultType: 'tmux_session', data: { name } };
    },
  };
}

const spawnFail =
  (errorCode, errorMessage = 'tmux new-session failed: boom') =>
  async name => ({
    ok: false,
    resultType: 'tmux_session',
    data: { name },
    errorCode,
    errorMessage,
  });

const spawnOk = async name => ({ ok: true, resultType: 'tmux_session', data: { name } });

/** Distinguishable shell/agent command lines. */
const cmdOk = value => ({ ok: true, resultType: 'database_read', data: { value } });
const SHELL_CMD = 'shell-cmd -l';
const AGENT_CMD = 'agent-cmd --run';
const CMD_FAIL = {
  ok: false,
  resultType: 'database_read',
  errorCode: 'database_error',
  errorMessage: 'could not read the terminal command',
};

/** Empty by default (a down tmux server reads the same). */
function liveNames(set = new Set()) {
  return { names: set, liveSessionNames: async () => set };
}

function domain(
  db,
  username = USERNAME,
  killSession = async () => true,
  defaultCwd = os.tmpdir(),
  spawnSession = spawnOk,
  live = liveNames(),
  shellCommand = () => cmdOk(SHELL_CMD),
  agentCommand = () => cmdOk(AGENT_CMD),
  appsRoot = path.join(os.tmpdir(), 'cybermole-ws-apps-root'),
) {
  return new Workspaces({
    db,
    username: () => username,
    killSession,
    defaultCwd,
    appsRoot,
    spawnSession,
    liveSessionNames: live.liveSessionNames,
    shellCommand,
    agentCommand,
  });
}

const wsRow = (db, id) =>
  db.get(
    qb
      .selectFrom('workspaces')
      .select(['id', 'app_id', 'name', 'cwd', 'kind', 'sort_order'])
      .where('id', '=', id),
  );
const termRows = (db, workspaceId) =>
  db.all(
    qb
      .selectFrom('terminals')
      .select(['id', 'title', 'sort_order', 'command', 'created_at'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('sort_order'),
  );

async function appless(db) {
  const a = new Apps({ db, username: () => USERNAME, killSession: async () => true });
  return (await a.saveApp('parent')).data;
}

// ---------- id schemas ----------

test('WorkspaceIdSchema / TerminalIdSchema: lowercase uuid v4 in, everything else out', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(WorkspaceIdSchema.parse(id), id);
  assert.equal(TerminalIdSchema.parse(id), id);
  for (const schema of [WorkspaceIdSchema, TerminalIdSchema]) {
    for (const bad of [
      '',
      'nope',
      id.toUpperCase(),
      '123e4567-e89b-72d3-a456-426614174000',
      '../x',
      5,
      null,
    ]) {
      assert.equal(schema.safeParse(bad).success, false, String(bad));
    }
  }
});

// ---------- save_workspace ----------

test('save_workspace: console (appId null) and app-scoped, cwd defaulting to the configured default', async () => {
  const db = freshDb();
  const w = domain(db);
  const console1 = await w.saveWorkspace({ name: 'scratch' });
  assert.equal(console1.ok, true, console1.errorMessage);
  assert.equal(console1.resultType, 'save_workspace');
  assert.equal(console1.data.appId, null);
  assert.equal(console1.data.cwd, os.tmpdir());
  assert.equal(console1.data.name, 'scratch');
  assert.match(console1.data.id, UUID_RE);
  assert.equal(wsRow(db, console1.data.id).sort_order, 10);
  const console2 = await w.saveWorkspace({ name: 'second', cwd: '/' });
  assert.equal(wsRow(db, console2.data.id).sort_order, 20); // order is per group
  const app = await appless(db);
  const scoped = await w.saveWorkspace({ appId: app.id, name: 'in app', cwd: '/' });
  assert.equal(scoped.data.appId, app.id);
  assert.equal(wsRow(db, scoped.data.id).sort_order, 10); // its own group's first
});

test('save_workspace: invalid_name on empty or whitespace-only names', async () => {
  const w = domain(freshDb());
  for (const name of ['', '   ']) {
    const r = await w.saveWorkspace({ name });
    assert.equal(r.ok, false, JSON.stringify(name));
    assert.equal(r.errorCode, 'invalid_name');
  }
});

test('save_workspace: invalid_cwd — relative, missing, a file; absolute + existing dir passes', async () => {
  const db = freshDb();
  const w = domain(db, USERNAME, async () => true, '/definitely-not-the-default');
  const file = path.join(os.tmpdir(), `cybermole-ws-file-${process.pid}`);
  fs.writeFileSync(file, '');
  for (const cwd of ['relative/path', '/definitely/not/here', file]) {
    const r = await w.saveWorkspace({ name: 'x', cwd });
    assert.equal(r.ok, false, cwd);
    assert.equal(r.errorCode, 'invalid_cwd');
    assert.ok(r.errorMessage.includes(cwd), cwd);
  }
  const good = await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() });
  assert.equal(good.ok, true, good.errorMessage);
  assert.equal(good.data.cwd, os.tmpdir());
});

test("save_workspace: the cwd DERIVES — the parent app's cwd, else the configured default", async () => {
  const db = freshDb();
  const defaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-ws-default-'));
  const w = domain(db, USERNAME, async () => true, defaultDir);
  const a = new Apps({ db, username: () => USERNAME, killSession: async () => true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-cwd-'));
  const placed = (await a.saveApp('placed', dir)).data;
  const bare = (await a.saveApp('bare')).data;
  // an app with a cwd: its workspaces start there
  const underPlaced = await w.saveWorkspace({ appId: placed.id, name: 'under placed' });
  assert.equal(underPlaced.ok, true, underPlaced.errorMessage);
  assert.equal(underPlaced.data.cwd, dir);
  assert.equal(wsRow(db, underPlaced.data.id).cwd, dir);
  // without one: the configured default, as for the console group
  const underBare = await w.saveWorkspace({ appId: bare.id, name: 'under bare' });
  assert.equal(underBare.ok, true, underBare.errorMessage);
  assert.equal(underBare.data.cwd, defaultDir);
  const consoleWs = await w.saveWorkspace({ name: 'console one' });
  assert.equal(consoleWs.data.cwd, defaultDir);
  // an explicit cwd (internal callers only) wins
  const explicit = await w.saveWorkspace({ appId: placed.id, name: 'explicit', cwd: os.tmpdir() });
  assert.equal(explicit.ok, true, explicit.errorMessage);
  assert.equal(explicit.data.cwd, os.tmpdir());
  // the derived cwd is validated: the app's dir may have gone
  fs.rmSync(dir, { recursive: true, force: true });
  const gone = await w.saveWorkspace({ appId: placed.id, name: 'gone' });
  assert.equal(gone.ok, false, gone.errorMessage);
  assert.equal(gone.errorCode, 'invalid_cwd');
  assert.ok(gone.errorMessage.includes(dir), gone.errorMessage);
});

test('save_workspace: app_not_found for a missing parent app', async () => {
  const w = domain(freshDb());
  const r = await w.saveWorkspace({ appId: MISSING_WS, name: 'x', cwd: '/' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'app_not_found');
});

// ---------- build workspaces (kind "build") ----------

test("save_workspace kind 'build': the default cwd (the parent app's cwd is skipped), kind stored, the framing env on the auto-opened tab", async () => {
  const db = freshDb();
  const defaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-ws-default-'));
  const appsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-ws-appsroot-'));
  const { spawned, spawnSession } = spawner();
  const w = domain(
    db,
    USERNAME,
    async () => true,
    defaultDir,
    spawnSession,
    liveNames(),
    () => cmdOk(SHELL_CMD),
    () => cmdOk(AGENT_CMD),
    appsRoot,
  );
  const a = new Apps({ db, username: () => USERNAME, killSession: async () => true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-cwd-'));
  const placed = (await a.saveApp('placed', dir)).data;
  const bare = (await a.saveApp('bare')).data;

  // the parent app's cwd is SKIPPED for build kind: the console default
  const build = await w.saveWorkspace({ appId: placed.id, name: 'build placed', kind: 'build' });
  assert.equal(build.ok, true, build.errorMessage);
  assert.equal(build.data.cwd, defaultDir);
  assert.equal(build.data.kind, 'build');
  assert.equal(wsRow(db, build.data.id).kind, 'build');
  // the auto-opened agent tab carries the framing env, tree = the app's cwd
  assert.equal(spawned[spawned.length - 1].command.join(' '), AGENT_CMD);
  assert.deepEqual(spawned[spawned.length - 1].env, {
    CYBERMOLE_WORKSPACE_FOCUS: 'placed',
    CYBERMOLE_WORKSPACE_FOCUS_TREE: dir,
  });
  assert.equal(spawned.length, 1);

  // an app without a cwd frames at <appsRoot>/<slug>
  const buildBare = await w.saveWorkspace({ appId: bare.id, name: 'build bare', kind: 'build' });
  assert.equal(buildBare.ok, true, buildBare.errorMessage);
  assert.equal(buildBare.data.cwd, defaultDir);
  assert.deepEqual(spawned[spawned.length - 1].env, {
    CYBERMOLE_WORKSPACE_FOCUS: 'bare',
    CYBERMOLE_WORKSPACE_FOCUS_TREE: path.join(appsRoot, 'bare'),
  });

  // a plain workspace under the same app: cwd still derives from the app, no env
  const plain = await w.saveWorkspace({ appId: placed.id, name: 'plain under placed' });
  assert.equal(plain.data.cwd, dir);
  assert.equal(plain.data.kind, null);
  assert.equal(wsRow(db, plain.data.id).kind, null);
  assert.equal(spawned[spawned.length - 1].env, undefined);
});

test("kind 'build' without an appId is invalid_kind; a patch never touches kind (it stays at birth)", async () => {
  const refused = await domain(freshDb()).saveWorkspace({ name: 'x', kind: 'build' });
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, 'invalid_kind');
  // a rename (the patch surface) never carries kind
  const db = freshDb();
  const a = new Apps({ db, username: () => USERNAME, killSession: async () => true });
  const app = (await a.saveApp('parent')).data;
  const w = domain(db);
  const made = (await w.saveWorkspace({ appId: app.id, name: 'build me', kind: 'build' })).data;
  const renamed = await w.updateWorkspace(made.id, { name: 'renamed' });
  assert.equal(renamed.ok, true, renamed.errorMessage);
  assert.equal(renamed.data.kind, 'build');
  const row = wsRow(db, made.id);
  assert.equal(row.name, 'renamed');
  assert.equal(row.kind, 'build');
});

test("a build workspace's + tab carries the framing env (spawn path two); terminalForAttach hands it to the respawn (path three)", async () => {
  const db = freshDb();
  const { spawned, spawnSession } = spawner();
  const w = domain(db, USERNAME, async () => true, os.tmpdir(), spawnSession);
  const a = new Apps({ db, username: () => USERNAME, killSession: async () => true });
  const app = (await a.saveApp('parent')).data;
  const made = (await w.saveWorkspace({ appId: app.id, name: 'build me', kind: 'build' })).data;
  const focus = {
    CYBERMOLE_WORKSPACE_FOCUS: 'parent',
    CYBERMOLE_WORKSPACE_FOCUS_TREE: path.join(os.tmpdir(), 'cybermole-ws-apps-root', 'parent'),
  };
  const plus = (await w.newTerminal(made.id, 'shell')).data; // a + tab
  const entry = spawned.find(s => s.name === terminalSessionName(plus.id));
  assert.equal(entry.command.join(' '), SHELL_CMD);
  assert.deepEqual(entry.env, focus);
  // the WS respawn reads the same env from terminalForAttach, agent tab or not
  const agentAttach = await w.terminalForAttach(termRows(db, made.id)[0].id);
  assert.equal(agentAttach.data.agent, true);
  assert.deepEqual(agentAttach.data.env, focus);
  const plusAttach = await w.terminalForAttach(plus.id);
  assert.deepEqual(plusAttach.data.env, focus);
  // and the tree rides kind for the client
  const tree = (await w.workspaceTree()).data.workspaces.find(x => x.id === made.id);
  assert.equal(tree.kind, 'build');
});

test('save_workspace: database_error — unwritable db, failed username read', async () => {
  const broken = await domain(brokenDb()).saveWorkspace({ name: 'x', cwd: '/' });
  assert.equal(broken.ok, false);
  assert.equal(broken.errorCode, 'database_error');
  const noUser = await domain(freshDb(), USERNAME_FAIL).saveWorkspace({ name: 'x', cwd: '/' });
  assert.equal(noUser.ok, false);
  assert.equal(noUser.errorCode, 'database_error');
});

// ---------- update_workspace ----------

test('update_workspace: name and cwd independently; absent fields keep; a no-op returns the row', async () => {
  const db = freshDb();
  const w = domain(db);
  const created = (await w.saveWorkspace({ name: 'first', cwd: os.tmpdir() })).data;
  const renamed = await w.updateWorkspace(created.id, { name: 'renamed' });
  assert.equal(renamed.ok, true, renamed.errorMessage);
  assert.equal(renamed.data.name, 'renamed');
  assert.equal(renamed.data.cwd, os.tmpdir()); // kept
  const moved = await w.updateWorkspace(created.id, { cwd: '/' });
  assert.equal(moved.data.cwd, '/');
  assert.equal(moved.data.name, 'renamed'); // kept
  const noop = await w.updateWorkspace(created.id, {});
  assert.deepEqual(noop.data, {
    id: created.id,
    appId: null,
    name: 'renamed',
    cwd: '/',
    kind: null,
  });
  assert.equal(wsRow(db, created.id).name, 'renamed');
});

test('update_workspace: invalid_name, invalid_cwd, workspace_not_found, database_error', async () => {
  const db = freshDb();
  const w = domain(db);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  assert.equal((await w.updateWorkspace(ws.id, { name: '' })).errorCode, 'invalid_name');
  assert.equal((await w.updateWorkspace(ws.id, { cwd: 'rel' })).errorCode, 'invalid_cwd');
  const missing = await w.updateWorkspace(MISSING_WS, { name: 'y' });
  assert.equal(missing.errorCode, 'workspace_not_found');
  assert.equal(missing.resultType, 'save_workspace');
  assert.equal(
    (await domain(brokenDb()).updateWorkspace(MISSING_WS, { name: 'y' })).errorCode,
    'database_error',
  );
});

// ---------- delete_workspace ----------

test('delete_workspace: cascades its terminals, kills their sessions best-effort; second delete is not-found', async () => {
  const db = freshDb();
  const { killed, killSession } = recorder();
  const w = domain(db, USERNAME, killSession);
  const other = (await w.saveWorkspace({ name: 'other', cwd: os.tmpdir() })).data;
  const otherAuto = termRows(db, other.id)[0].id; // the create's agent tab
  const otherTerm = (await w.newTerminal(other.id, undefined)).data;
  const doomed = (await w.saveWorkspace({ name: 'doomed', cwd: os.tmpdir() })).data;
  const doomedAuto = termRows(db, doomed.id)[0].id;
  const t1 = (await w.newTerminal(doomed.id, 'one')).data;
  const t2 = (await w.newTerminal(doomed.id, undefined)).data;

  const deleted = await w.deleteWorkspace(doomed.id);
  assert.equal(deleted.ok, true, deleted.errorMessage);
  assert.equal(deleted.resultType, 'delete_workspace');
  assert.deepEqual(deleted.data, { id: doomed.id });
  assert.equal(wsRow(db, doomed.id), undefined);
  assert.deepEqual(termRows(db, doomed.id), []);
  // the auto-opened agent tab dies with them
  assert.deepEqual(
    killed.sort(),
    [
      terminalSessionName(doomedAuto),
      terminalSessionName(t1.id),
      terminalSessionName(t2.id),
    ].sort(),
  );
  assert.equal(killed.includes(terminalSessionName(otherTerm.id)), false);
  assert.deepEqual(
    termRows(db, other.id).map(r => r.id),
    [otherAuto, otherTerm.id],
  );

  const again = await w.deleteWorkspace(doomed.id);
  assert.equal(again.errorCode, 'workspace_not_found');
});

test('delete_workspace: workspace_not_found / database_error; a failing kill never fails the delete', async () => {
  const w = domain(freshDb(), USERNAME, async () => false);
  assert.equal((await w.deleteWorkspace(MISSING_WS)).errorCode, 'workspace_not_found');
  assert.equal((await domain(brokenDb()).deleteWorkspace(MISSING_WS)).errorCode, 'database_error');
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  await w.newTerminal(ws.id, undefined);
  const still = await w.deleteWorkspace(ws.id);
  assert.equal(still.ok, true, still.errorMessage);
});

// ---------- new_terminal ----------

test('new_terminal: inserts the row (title optional, order max+10), spawns t-<uuid> at the workspace cwd, live:true', async () => {
  const db = freshDb();
  const { spawned, spawnSession } = spawner();
  const w = domain(db, USERNAME, async () => true, os.tmpdir(), spawnSession);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  // the auto-opened agent tab (tested below) is the baseline
  const auto = termRows(db, ws.id)[0];
  assert.deepEqual(
    spawned,
    [
      {
        name: terminalSessionName(auto.id),
        cwd: os.tmpdir(),
        command: AGENT_CMD.split(' '),
        env: undefined,
      },
    ],
    'the auto-open spawned the AGENT command at the workspace cwd',
  );
  const first = await w.newTerminal(ws.id, 'main');
  assert.equal(first.ok, true, first.errorMessage);
  assert.equal(first.resultType, 'new_terminal');
  assert.equal(first.data.workspaceId, ws.id);
  assert.equal(first.data.title, 'main');
  assert.equal(first.data.live, true); // the spawn succeeded
  assert.match(first.data.id, UUID_RE);
  assert.deepEqual(
    spawned[1],
    {
      name: terminalSessionName(first.data.id),
      cwd: os.tmpdir(),
      command: SHELL_CMD.split(' '),
      env: undefined,
    },
    'a + button tab spawns the SHELL command, split on whitespace',
  );
  const second = await w.newTerminal(ws.id, undefined);
  assert.equal(second.data.title, null);
  assert.equal(second.data.live, true);
  const third = await w.newTerminal(ws.id, 'extra');
  assert.deepEqual(
    termRows(db, ws.id).map(r => r.sort_order),
    [10, 20, 30, 40],
  );
  const row = db.get(
    qb.selectFrom('terminals').select('created_by').where('id', '=', third.data.id),
  );
  assert.equal(row.created_by, 'tester');
});

test('save_workspace auto-opens the first terminal with the AGENT command — and a failed spawn never fails the create', async () => {
  const db = freshDb();
  const { spawned, spawnSession } = spawner();
  const w = domain(db, USERNAME, async () => true, os.tmpdir(), spawnSession);
  const made = await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() });
  assert.equal(made.ok, true, made.errorMessage); // the create succeeded
  const rows = termRows(db, made.data.id);
  assert.equal(rows.length, 1, 'the workspace arrives with its first tab');
  assert.equal(rows[0].title, null); // untitled — the UI labels it "term 1"
  assert.equal(rows[0].sort_order, 10);
  assert.deepEqual(spawned, [
    {
      name: terminalSessionName(rows[0].id),
      cwd: os.tmpdir(),
      command: AGENT_CMD.split(' '),
      env: undefined,
    },
  ]);

  // The guard refusing at create time: the row still lands (a dead tab)
  // and the create succeeds.
  const db2 = freshDb();
  const refusing = domain(
    db2,
    USERNAME,
    async () => true,
    os.tmpdir(),
    spawnFail('server_not_running', SERVER_NOT_RUNNING_MSG),
  );
  const made2 = await refusing.saveWorkspace({ name: 'y', cwd: os.tmpdir() });
  assert.equal(made2.ok, true, made2.errorMessage);
  const rows2 = termRows(db2, made2.data.id);
  assert.equal(rows2.length, 1, 'the row exists even though the spawn refused');

  // A failed command read: no tab row, but the workspace create still succeeds.
  const db3 = freshDb();
  const noCmd = new Workspaces({
    db: db3,
    username: () => USERNAME,
    killSession: async () => true,
    defaultCwd: os.tmpdir(),
    spawnSession: spawnOk,
    liveSessionNames: liveNames().liveSessionNames,
    shellCommand: () => cmdOk(SHELL_CMD),
    agentCommand: () => CMD_FAIL,
  });
  const made3 = await noCmd.saveWorkspace({ name: 'z', cwd: os.tmpdir() });
  assert.equal(made3.ok, true, made3.errorMessage);
  assert.deepEqual(termRows(db3, made3.data.id), []);
});

test('new_terminal: the row exists even when the spawn fails — server_not_running / tmux_error carry it (live:false)', async () => {
  const db = freshDb();
  const ws = (await domain(db).saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  // The guard's refusal: the row is still created and returned.
  const w = domain(
    db,
    USERNAME,
    async () => true,
    os.tmpdir(),
    spawnFail('server_not_running', SERVER_NOT_RUNNING_MSG),
  );
  const refused = await w.newTerminal(ws.id, undefined);
  assert.equal(refused.ok, false, 'the spawn failure must report');
  assert.equal(refused.resultType, 'new_terminal');
  assert.equal(refused.errorCode, 'server_not_running');
  assert.equal(refused.data.workspaceId, ws.id);
  assert.equal(refused.data.live, false); // a dead tab, not a missing one
  assert.deepEqual(
    termRows(db, ws.id).map(r => r.id),
    [termRows(db, ws.id)[0].id, refused.data.id],
    'the auto-opened tab, then the row that EXISTS despite the failure',
  );
  // tmux's own failure: same contract
  const w2 = domain(db, USERNAME, async () => true, os.tmpdir(), spawnFail('tmux_error'));
  const failed = await w2.newTerminal(ws.id, 'two');
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'tmux_error');
  assert.equal(failed.data.title, 'two');
  assert.equal(failed.data.live, false);
  assert.equal(termRows(db, ws.id).length, 3); // auto + refused + failed
});

test('new_terminal: workspace_not_found / database_error (no row, no spawn)', async () => {
  const { spawned, spawnSession } = spawner();
  const w = domain(freshDb(), USERNAME, async () => true, os.tmpdir(), spawnSession);
  const missing = await w.newTerminal(MISSING_WS, undefined);
  assert.equal(missing.errorCode, 'workspace_not_found');
  assert.equal(missing.resultType, 'new_terminal');
  assert.equal(missing.data, undefined); // nothing was created
  assert.deepEqual(spawned, []); // nothing was spawned
  const broken = await domain(brokenDb()).newTerminal(MISSING_WS, undefined);
  assert.equal(broken.errorCode, 'database_error');
});

test('new_terminal: command picks the spawn — shell by default, agent on request — and is stored for respawns', async () => {
  const db = freshDb();
  const { spawned, spawnSession } = spawner();
  const w = domain(db, USERNAME, async () => true, os.tmpdir(), spawnSession);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  // The auto-opened first tab is the agent tab and says so in its row.
  assert.equal(termRows(db, ws.id)[0].command, 'agent');

  const shell = await w.newTerminal(ws.id, 'plain');
  assert.equal(shell.ok, true, shell.errorMessage);
  const agent = await w.newTerminal(ws.id, 'a second agent', 'agent');
  assert.equal(agent.ok, true, agent.errorMessage);
  assert.deepEqual(
    spawned.map(s => s.command.join(' ')),
    [AGENT_CMD, SHELL_CMD, AGENT_CMD],
  );
  assert.deepEqual(
    termRows(db, ws.id).map(r => r.command),
    ['agent', 'shell', 'agent'],
  );
  // A later agent tab never borrows the created_at agent slot: the flag
  // comes from the row, and created_at stays strictly later than the ws.
  const wsRowCreated = db.get(
    qb.selectFrom('workspaces').select('created_at').where('id', '=', ws.id),
  ).created_at;
  assert.ok(termRows(db, ws.id)[2].created_at > wsRowCreated);

  // A failed agent-command read: no row, no spawn.
  const db2 = freshDb();
  const ws2 = (await domain(db2).saveWorkspace({ name: 'y', cwd: os.tmpdir() })).data;
  const noAgent = domain(
    db2,
    USERNAME,
    async () => true,
    os.tmpdir(),
    spawnSession,
    liveNames(),
    () => cmdOk(SHELL_CMD),
    () => CMD_FAIL,
  );
  const refused = await noAgent.newTerminal(ws2.id, undefined, 'agent');
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, 'database_error');
  assert.equal(termRows(db2, ws2.id).length, 1); // only the auto-opened tab
});

// ---------- reorder_terminals ----------

test('reorder_terminals: rewrites sort_order in steps of 10; a same-order call writes nothing', async () => {
  const db = freshDb();
  const w = domain(db);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  const a = termRows(db, ws.id)[0].id; // the auto-opened agent tab
  const b = (await w.newTerminal(ws.id, 'two')).data.id;
  const c = (await w.newTerminal(ws.id, 'three')).data.id;
  assert.deepEqual(
    termRows(db, ws.id).map(r => r.id),
    [a, b, c],
  );

  const reordered = await w.reorderTerminals(ws.id, [c, a, b]);
  assert.equal(reordered.ok, true, reordered.errorMessage);
  assert.equal(reordered.resultType, 'reorder_terminals');
  assert.deepEqual(reordered.data, { workspaceId: ws.id, order: [c, a, b] });
  assert.deepEqual(
    termRows(db, ws.id).map(r => [r.id, r.sort_order]),
    [
      [c, 10],
      [a, 20],
      [b, 30],
    ],
  );
  // titles and commands ride along untouched
  assert.deepEqual(
    termRows(db, ws.id).map(r => [r.title, r.command]),
    [
      ['three', 'shell'],
      [null, 'agent'],
      ['two', 'shell'],
    ],
  );
  // the tree reads the new order
  const tree = (await w.workspaceTree()).data.workspaces.find(x => x.id === ws.id);
  assert.deepEqual(
    tree.terminals.map(t => t.id),
    [c, a, b],
  );

  // A same-order reorder is a no-op success (updated_by/updated_at untouched).
  const before = db.get(
    qb.selectFrom('terminals').select(['id', 'updated_at']).where('id', '=', c),
  );
  await new Promise(r => setTimeout(r, 2));
  const again = await w.reorderTerminals(ws.id, [c, a, b]);
  assert.equal(again.ok, true, again.errorMessage);
  const after = db.get(qb.selectFrom('terminals').select(['id', 'updated_at']).where('id', '=', c));
  assert.equal(after.updated_at, before.updated_at);
});

test('reorder_terminals: invalid_order on a duplicate, an unknown id, or a partial list; the db is untouched', async () => {
  const db = freshDb();
  const w = domain(db);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  const a = termRows(db, ws.id)[0].id;
  const b = (await w.newTerminal(ws.id, 'two')).data.id;
  const other = (await w.saveWorkspace({ name: 'other', cwd: os.tmpdir() })).data;
  const foreign = termRows(db, other.id)[0].id;

  for (const order of [
    [a, a], // duplicate
    [a, foreign], // a terminal of ANOTHER workspace
    [a], // missing b
    [a, b, MISSING_WS], // unknown id
  ]) {
    const r = await w.reorderTerminals(ws.id, order);
    assert.equal(r.ok, false, JSON.stringify(order));
    assert.equal(r.errorCode, 'invalid_order');
    assert.equal(r.resultType, 'reorder_terminals');
  }
  assert.deepEqual(
    termRows(db, ws.id).map(r => [r.id, r.sort_order]),
    [
      [a, 10],
      [b, 20],
    ],
    'a refused reorder writes nothing',
  );
});

test('reorder_terminals: workspace_not_found / database_error', async () => {
  const w = domain(freshDb());
  const missing = await w.reorderTerminals(MISSING_WS, []);
  assert.equal(missing.errorCode, 'workspace_not_found');
  assert.equal(
    (await domain(brokenDb()).reorderTerminals(MISSING_WS, [])).errorCode,
    'database_error',
  );
});

// ---------- reorder_workspaces ----------

test('reorder_workspaces: rewrites one group in steps of 10; other groups and a same-order call write nothing', async () => {
  const db = freshDb();
  const w = domain(db);
  const app = await appless(db);
  // Deterministic created_at: it tiebreaks equal sort_order in the tree.
  const a = (await w.saveWorkspace({ name: 'a', cwd: os.tmpdir() })).data.id;
  await new Promise(r => setTimeout(r, 3));
  const b = (await w.saveWorkspace({ name: 'b', cwd: os.tmpdir() })).data.id;
  await new Promise(r => setTimeout(r, 3));
  const c = (await w.saveWorkspace({ appId: app.id, name: 'c', cwd: os.tmpdir() })).data.id;
  assert.deepEqual(
    [wsRow(db, a).sort_order, wsRow(db, b).sort_order, wsRow(db, c).sort_order],
    [10, 20, 10], // each group numbers its own rows
  );

  const reordered = await w.reorderWorkspaces([b, a]);
  assert.equal(reordered.ok, true, reordered.errorMessage);
  assert.equal(reordered.resultType, 'reorder_workspaces');
  assert.deepEqual(reordered.data, { order: [b, a] });
  assert.deepEqual(
    [wsRow(db, b).sort_order, wsRow(db, a).sort_order, wsRow(db, c).sort_order],
    [10, 20, 10], // the app group is another list entirely
  );

  // The tree reads the new order (sort_order, then created_at).
  const tree = (await w.workspaceTree()).data.workspaces;
  assert.deepEqual(
    tree.map(x => x.id),
    [b, c, a],
  );

  // A same-order reorder is a no-op success (updated_at untouched).
  const before = wsRow(db, b).updated_at;
  await new Promise(r => setTimeout(r, 2));
  const again = await w.reorderWorkspaces([b, a]);
  assert.equal(again.ok, true, again.errorMessage);
  assert.equal(wsRow(db, b).updated_at, before);
});

test('reorder_workspaces: invalid_order on a duplicate, an unknown id, a partial list or mixed groups; the db is untouched', async () => {
  const db = freshDb();
  const w = domain(db);
  const app = await appless(db);
  const a = (await w.saveWorkspace({ name: 'a', cwd: os.tmpdir() })).data.id;
  const b = (await w.saveWorkspace({ name: 'b', cwd: os.tmpdir() })).data.id;
  const c = (await w.saveWorkspace({ appId: app.id, name: 'c', cwd: os.tmpdir() })).data.id;

  for (const order of [
    [a, a], // duplicate
    [a, c], // two groups in one order
    [a], // missing b
    [a, b, MISSING_WS], // unknown id
    [], // nothing to reorder
  ]) {
    const r = await w.reorderWorkspaces(order);
    assert.equal(r.ok, false, JSON.stringify(order));
    assert.equal(r.errorCode, 'invalid_order');
    assert.equal(r.resultType, 'reorder_workspaces');
  }
  assert.deepEqual(
    [wsRow(db, a).sort_order, wsRow(db, b).sort_order, wsRow(db, c).sort_order],
    [10, 20, 10],
    'a refused reorder writes nothing',
  );
});

test('reorder_workspaces: an app group reorders too; database_error on a broken db', async () => {
  const db = freshDb();
  const w = domain(db);
  const app = await appless(db);
  const c = (await w.saveWorkspace({ appId: app.id, name: 'c', cwd: os.tmpdir() })).data.id;
  const d = (await w.saveWorkspace({ appId: app.id, name: 'd', cwd: os.tmpdir() })).data.id;
  const r = await w.reorderWorkspaces([d, c]);
  assert.equal(r.ok, true, r.errorMessage);
  assert.deepEqual([wsRow(db, d).sort_order, wsRow(db, c).sort_order], [10, 20]);
  assert.equal((await domain(brokenDb()).reorderWorkspaces([d])).errorCode, 'database_error');
});

// ---------- close / rename ----------

test('close_terminal: deletes the row and best-effort-kills the derived session name; terminal_not_found after', async () => {
  const db = freshDb();
  const { killed, killSession } = recorder();
  const w = domain(db, USERNAME, killSession);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  const t = (await w.newTerminal(ws.id, 'main')).data;
  const closed = await w.closeTerminal(t.id);
  assert.equal(closed.ok, true, closed.errorMessage);
  assert.equal(closed.resultType, 'close_terminal');
  assert.deepEqual(closed.data, { id: t.id });
  // the auto-opened tab remains
  assert.equal(termRows(db, ws.id).length, 1);
  assert.deepEqual(killed, [terminalSessionName(t.id)]); // 't-<uuid>' — derived, never stored
  const again = await w.closeTerminal(t.id);
  assert.equal(again.errorCode, 'terminal_not_found');
  assert.equal((await domain(brokenDb()).closeTerminal(t.id)).errorCode, 'database_error');
});

test('close_terminal: a FAILING kill still deletes the row (best-effort)', async () => {
  const db = freshDb();
  const w = domain(db, USERNAME, async () => false); // kill-session errors
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  const t = (await w.newTerminal(ws.id, undefined)).data;
  const closed = await w.closeTerminal(t.id);
  assert.equal(closed.ok, true, 'a failed kill must never fail the close');
  assert.equal(termRows(db, ws.id).length, 1, 'the auto-opened row is gone either way');
});

test('rename_terminal: sets the title, null clears it; terminal_not_found / database_error', async () => {
  const db = freshDb();
  const w = domain(db);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  const t = (await w.newTerminal(ws.id, undefined)).data;
  const set = await w.renameTerminal(t.id, 'build log');
  assert.equal(set.ok, true, set.errorMessage);
  assert.deepEqual(set.data, { id: t.id, title: 'build log' });
  assert.equal(termRows(db, ws.id)[1].title, 'build log'); // [0] is the auto-opened tab
  const cleared = await w.renameTerminal(t.id, null);
  assert.deepEqual(cleared.data, { id: t.id, title: null });
  assert.equal(termRows(db, ws.id)[1].title, null);
  const noop = await w.renameTerminal(t.id, undefined); // absent title: no-op read-back
  assert.deepEqual(noop.data, { id: t.id, title: null });
  const missing = await w.renameTerminal(MISSING_WS, 'x');
  assert.equal(missing.errorCode, 'terminal_not_found');
  assert.equal(missing.resultType, 'rename_terminal');
  assert.equal(
    (await domain(brokenDb()).renameTerminal(MISSING_WS, 'x')).errorCode,
    'database_error',
  );
});

// ---------- terminalForAttach ----------

test("terminalForAttach: the row + its workspace's cwd + the agent-slot flag; terminal_not_found / database_error", async () => {
  const db = freshDb();
  const w = domain(db);
  const app = await appless(db);
  const ws = (await w.saveWorkspace({ appId: app.id, name: 'x', cwd: os.tmpdir() })).data;
  const auto = termRows(db, ws.id)[0].id; // the create's auto-opened tab
  const t = (await w.newTerminal(ws.id, 'main')).data;
  const found = await w.terminalForAttach(t.id);
  assert.equal(found.ok, true, found.errorMessage);
  assert.equal(found.resultType, 'terminal_for_attach');
  assert.deepEqual(found.data, {
    id: t.id,
    workspaceId: ws.id,
    title: 'main',
    cwd: os.tmpdir(),
    agent: false, // a + button tab: the respawn re-runs the SHELL command
    env: null, // a plain workspace carries no framing env
  });
  // the auto-opened tab respawns the agent command
  const autoFound = await w.terminalForAttach(auto);
  assert.equal(autoFound.data.agent, true);
  assert.equal(autoFound.data.title, null);
  // Closing it flags nothing else: created_at equality, not sort_order.
  await w.closeTerminal(auto);
  assert.equal((await w.terminalForAttach(t.id)).data.agent, false);
  const missing = await w.terminalForAttach(MISSING_WS);
  assert.equal(missing.errorCode, 'terminal_not_found');
  assert.equal(
    (await domain(brokenDb()).terminalForAttach(MISSING_WS)).errorCode,
    'database_error',
  );
});

test("terminalForAttach: the stored command decides the respawn — 'agent' rows stay agents, 'shell' rows stay shells, pre-v7 NULL rows keep the created_at derivation", async () => {
  const db = freshDb();
  const w = domain(db);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  const wsCreated = db.get(
    qb.selectFrom('workspaces').select('created_at').where('id', '=', ws.id),
  ).created_at;
  const madeAgent = (await w.newTerminal(ws.id, 'later agent', 'agent')).data;
  const madeShell = (await w.newTerminal(ws.id, 'later shell', 'shell')).data;

  assert.equal((await w.terminalForAttach(madeAgent.id)).data.agent, true);
  assert.equal((await w.terminalForAttach(madeShell.id)).data.agent, false);

  // Two pre-v7 rows (command NULL): the auto-opened one shares the
  // workspace's created_at, the + one is strictly later.
  const legacy = (id, command, created) =>
    db.run(
      qb.insertInto('terminals').values({
        id,
        workspace_id: ws.id,
        title: null,
        sort_order: 100,
        command,
        created_at: created,
        updated_at: created,
        created_by: 'tester',
        updated_by: 'tester',
      }),
    );
  const asTerminalId = id => id; // branded ids round-trip through the db
  legacy(asTerminalId('123e4567-e89b-42d3-a456-426614174111'), null, wsCreated);
  legacy(asTerminalId('123e4567-e89b-42d3-a456-426614174112'), null, wsCreated + 5);
  assert.equal(
    (await w.terminalForAttach(asTerminalId('123e4567-e89b-42d3-a456-426614174111'))).data.agent,
    true,
    'a legacy row at the workspace\u2019s created_at derives agent',
  );
  assert.equal(
    (await w.terminalForAttach(asTerminalId('123e4567-e89b-42d3-a456-426614174112'))).data.agent,
    false,
    'a legacy row created later derives shell',
  );
});

// ---------- workspaceTree ----------

test('workspaceTree: flat with appId, terminals in order, live from the tmux name set', async () => {
  const db = freshDb();
  const parent = await appless(db);
  const names = new Set();
  const w = domain(db, USERNAME, async () => true, os.tmpdir(), spawnOk, liveNames(names));

  const consoleWs = await w.saveWorkspace({ name: 'scratch' }); // appId null
  const appWs = await w.saveWorkspace({ appId: parent.id, name: 'proj' });
  const orphan = await w.saveWorkspace({ name: 'other' });
  // each create auto-opened a tab
  const autoConsole = termRows(db, consoleWs.data.id)[0].id;
  const t1 = await w.newTerminal(consoleWs.data.id, undefined);
  const t2 = await w.newTerminal(consoleWs.data.id, 'build');
  const t3 = await w.newTerminal(appWs.data.id, undefined);
  assert.equal(t1.ok && t2.ok && t3.ok, true);

  let tree = await w.workspaceTree();
  assert.equal(tree.ok, true, tree.errorMessage);
  assert.equal(tree.resultType, 'workspace_tree');
  assert.deepEqual(
    tree.data.workspaces.map(x => [x.id, x.appId]),
    [
      [consoleWs.data.id, null],
      [appWs.data.id, parent.id],
      [orphan.data.id, null],
    ],
  );
  const scratch = tree.data.workspaces.find(x => x.id === consoleWs.data.id);
  assert.equal(scratch.name, 'scratch');
  assert.equal(scratch.cwd, os.tmpdir());
  assert.deepEqual(
    scratch.terminals.map(t => [t.title, t.order, t.live]),
    [
      [null, 10, false],
      [null, 20, false],
      ['build', 30, false],
    ],
  );
  assert.equal(scratch.terminals[0].id, autoConsole);
  assert.equal(scratch.terminals[1].id, t1.data.id);
  assert.equal(tree.data.workspaces.find(x => x.id === appWs.data.id).terminals.length, 2);

  // t-<uuid> in the tmux set flips exactly that tab
  names.add(terminalSessionName(t2.data.id));
  tree = await w.workspaceTree();
  assert.deepEqual(
    tree.data.workspaces.find(x => x.id === consoleWs.data.id).terminals.map(t => t.live),
    [false, false, true],
  );

  // rows deleted out-of-band leave no phantom tabs
  await w.closeTerminal(t1.data.id);
  tree = await w.workspaceTree();
  assert.equal(tree.data.workspaces.find(x => x.id === consoleWs.data.id).terminals.length, 2);
});

test('workspaceTree: database_error on an unreadable db', async () => {
  const w = domain(brokenDb());
  const tree = await w.workspaceTree();
  assert.equal(tree.ok, false);
  assert.equal(tree.resultType, 'workspace_tree');
  assert.equal(tree.errorCode, 'database_error');
  assert.match(tree.errorMessage, /could not read/);
});
