// workspaces.test.mjs — the workspace + terminal domain
// (src/lib/workspaces.ts, workspaces-plan §3): every Result family at
// every error code — save/update/delete workspace, new/close/rename
// terminal, the attach lookup — including the cascade deletes and the
// best-effort tmux kills. Runs against dist-server (npm run test:unit).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb, qb } from '../../dist-server/src/lib/db.js';
import { Workspaces } from '../../dist-server/src/lib/workspaces.js';
import { Apps } from '../../dist-server/src/lib/apps.js';
import { terminalSessionName } from '../../dist-server/src/lib/tmux.js';
import { UUID_RE } from '../../dist-server/src/schemas/patterns.js';
import { WorkspaceIdSchema, TerminalIdSchema } from '../../dist-server/src/schemas/ids.js';

const USERNAME = { ok: true, resultType: 'database_read', data: { value: 'tester' } };
const USERNAME_FAIL = {
  ok: false, resultType: 'database_read', errorCode: 'database_error', errorMessage: 'could not read the credential',
};
const MISSING_WS = '99999999-9999-4999-8999-999999999999'; // a well-formed uuid v4 that is not ours

function freshDb() {
  return new StateDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-ws-')), 'webpi.db'));
}

function brokenDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-ws-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  return new StateDb(path.join(file, 'webpi.db'));
}

function recorder() {
  const killed = [];
  return { killed, killSession: async name => (killed.push(name), true) };
}

function domain(db, username = USERNAME, killSession = async () => true, defaultCwd = os.tmpdir()) {
  return new Workspaces({ db, username: () => username, killSession, defaultCwd, sessionEnv: {} });
}

const wsRow = (db, id) =>
  db.get(qb.selectFrom('workspaces').select(['id', 'app_id', 'name', 'cwd', 'sort_order']).where('id', '=', id));
const termRows = (db, workspaceId) =>
  db.all(qb.selectFrom('terminals').select(['id', 'title', 'sort_order']).where('workspace_id', '=', workspaceId)
    .orderBy('sort_order'));

async function appless(db) {
  // an app row is only needed for the parent tests; make it through the domain
  const { killed, killSession } = recorder();
  const a = new Apps({ db, username: () => USERNAME, killSession });
  return (await a.saveApp('parent')).data;
}

// ---------- id schemas the path params use ----------

test('WorkspaceIdSchema / TerminalIdSchema: lowercase uuid v4 in, everything else out', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(WorkspaceIdSchema.parse(id), id);
  assert.equal(TerminalIdSchema.parse(id), id);
  for (const schema of [WorkspaceIdSchema, TerminalIdSchema]) {
    for (const bad of ['', 'nope', id.toUpperCase(), '123e4567-e89b-72d3-a456-426614174000', '../x', 5, null]) {
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
  const file = path.join(os.tmpdir(), `webpi-ws-file-${process.pid}`);
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

test('save_workspace: app_not_found for a missing parent app', async () => {
  const w = domain(freshDb());
  const r = await w.saveWorkspace({ appId: MISSING_WS, name: 'x', cwd: '/' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'app_not_found');
});

test('save_workspace: database_error — unwritable db, failed username read', async () => {
  const broken = await domain(brokenDb()).saveWorkspace({ name: 'x', cwd: '/' });
  assert.equal(broken.ok, false);
  assert.equal(broken.errorCode, 'database_error');
  const noUser = await domain(freshDb(), USERNAME_FAIL).saveWorkspace({ name: 'x', cwd: '/' });
  assert.equal(noUser.ok, false);
  assert.equal(noUser.errorCode, 'database_error');
});

// ---------- update_workspace (same family) ----------

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
  assert.deepEqual(noop.data, { id: created.id, appId: null, name: 'renamed', cwd: '/' });
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
  assert.equal((await domain(brokenDb()).updateWorkspace(MISSING_WS, { name: 'y' })).errorCode, 'database_error');
});

// ---------- delete_workspace ----------

test('delete_workspace: cascades its terminals, kills their sessions best-effort; second delete is not-found', async () => {
  const db = freshDb();
  const { killed, killSession } = recorder();
  const w = domain(db, USERNAME, killSession);
  const other = (await w.saveWorkspace({ name: 'other', cwd: os.tmpdir() })).data;
  const otherTerm = (await w.newTerminal(other.id, undefined)).data;
  const doomed = (await w.saveWorkspace({ name: 'doomed', cwd: os.tmpdir() })).data;
  const t1 = (await w.newTerminal(doomed.id, 'one')).data;
  const t2 = (await w.newTerminal(doomed.id, undefined)).data;

  const deleted = await w.deleteWorkspace(doomed.id);
  assert.equal(deleted.ok, true, deleted.errorMessage);
  assert.equal(deleted.resultType, 'delete_workspace');
  assert.deepEqual(deleted.data, { id: doomed.id });
  assert.equal(wsRow(db, doomed.id), undefined);
  assert.deepEqual(termRows(db, doomed.id), []);
  assert.deepEqual(killed.sort(), [terminalSessionName(t1.id), terminalSessionName(t2.id)].sort());
  assert.equal(killed.includes(terminalSessionName(otherTerm.id)), false);
  assert.deepEqual(termRows(db, other.id).map(r => r.id), [otherTerm.id]);

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

test('new_terminal: inserts the row (title optional, order max+10) and answers live:false — no spawn in this branch', async () => {
  const db = freshDb();
  const w = domain(db);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  const first = await w.newTerminal(ws.id, 'main');
  assert.equal(first.ok, true, first.errorMessage);
  assert.equal(first.resultType, 'new_terminal');
  assert.deepEqual(first.data, { id: first.data.id, workspaceId: ws.id, title: 'main', live: false });
  assert.match(first.data.id, UUID_RE);
  const second = await w.newTerminal(ws.id, undefined);
  assert.equal(second.data.title, null);
  assert.equal(second.data.live, false);
  const third = await w.newTerminal(ws.id, 'extra');
  assert.deepEqual(termRows(db, ws.id).map(r => r.sort_order), [10, 20, 30]);
  // created_by stamps the credential username
  const row = db.get(qb.selectFrom('terminals').select('created_by').where('id', '=', third.data.id));
  assert.equal(row.created_by, 'tester');
});

test('new_terminal: workspace_not_found / database_error', async () => {
  const w = domain(freshDb());
  assert.equal((await w.newTerminal(MISSING_WS, undefined)).errorCode, 'workspace_not_found');
  assert.equal((await w.newTerminal(MISSING_WS, undefined)).resultType, 'new_terminal');
  assert.equal((await domain(brokenDb()).newTerminal(MISSING_WS, undefined)).errorCode, 'database_error');
});

// ---------- close / rename terminal ----------

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
  assert.deepEqual(termRows(db, ws.id), []);
  assert.deepEqual(killed, [terminalSessionName(t.id)]); // 't-<uuid>' — derived, never stored
  const again = await w.closeTerminal(t.id);
  assert.equal(again.errorCode, 'terminal_not_found');
  assert.equal((await domain(brokenDb()).closeTerminal(t.id)).errorCode, 'database_error');
});

test('rename_terminal: sets the title, null clears it; terminal_not_found / database_error', async () => {
  const db = freshDb();
  const w = domain(db);
  const ws = (await w.saveWorkspace({ name: 'x', cwd: os.tmpdir() })).data;
  const t = (await w.newTerminal(ws.id, undefined)).data;
  const set = await w.renameTerminal(t.id, 'build log');
  assert.equal(set.ok, true, set.errorMessage);
  assert.deepEqual(set.data, { id: t.id, title: 'build log' });
  assert.equal(termRows(db, ws.id)[0].title, 'build log');
  const cleared = await w.renameTerminal(t.id, null);
  assert.deepEqual(cleared.data, { id: t.id, title: null });
  assert.equal(termRows(db, ws.id)[0].title, null);
  const missing = await w.renameTerminal(MISSING_WS, 'x');
  assert.equal(missing.errorCode, 'terminal_not_found');
  assert.equal(missing.resultType, 'rename_terminal');
  assert.equal((await domain(brokenDb()).renameTerminal(MISSING_WS, 'x')).errorCode, 'database_error');
});

// ---------- terminalForAttach (main.ts's WS path lookup — task/ws-terminal) ----------

test('terminalForAttach: the row + its workspace\'s cwd; terminal_not_found / database_error', async () => {
  const db = freshDb();
  const w = domain(db);
  const app = await appless(db);
  const ws = (await w.saveWorkspace({ appId: app.id, name: 'x', cwd: os.tmpdir() })).data;
  const t = (await w.newTerminal(ws.id, 'main')).data;
  const found = await w.terminalForAttach(t.id);
  assert.equal(found.ok, true, found.errorMessage);
  assert.equal(found.resultType, 'terminal_for_attach');
  assert.deepEqual(found.data, { id: t.id, workspaceId: ws.id, title: 'main', cwd: os.tmpdir() });
  const missing = await w.terminalForAttach(MISSING_WS);
  assert.equal(missing.errorCode, 'terminal_not_found');
  assert.equal((await domain(brokenDb()).terminalForAttach(MISSING_WS)).errorCode, 'database_error');
});
