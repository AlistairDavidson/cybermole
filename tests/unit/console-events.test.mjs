// The sidebar's push wiring: workspaces.ts and apps.ts publish domain
// events on every mutation (failures publish nothing), and the liveness
// watcher publishes state-changed when the live-session set moves — that
// out-of-band heal is what replaced the console page's 15 s poll.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb } from '../../dist-server/src/lib/platform/db.js';
import { Workspaces } from '../../dist-server/src/lib/terminals/workspaces.js';
import { Apps } from '../../dist-server/src/lib/apps/apps.js';
import { startLivenessWatch } from '../../dist-server/src/lib/terminals/liveness.js';
import { onDomainEvent } from '../../dist-server/src/lib/platform/events.js';

const USERNAME = { ok: true, resultType: 'database_read', data: { value: 'tester' } };
/** A well-formed uuid v4 that is not ours. */
const MISSING_WS = '99999999-9999-4999-8999-999999999999';

function freshDb() {
  return new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-console-events-')), 'cybermole.db'),
  );
}

/** Its state db can never open (the parent is a file). */
function brokenDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-console-events-')), 'x');
  fs.writeFileSync(file, '');
  return new StateDb(path.join(file, 'cybermole.db'));
}

const spawnOk = async name => ({ ok: true, resultType: 'tmux_session', data: { name } });
const cmdOk = value => ({ ok: true, resultType: 'database_read', data: { value } });

function workspaces(db) {
  return new Workspaces({
    db,
    username: () => USERNAME,
    killSession: async () => true,
    defaultCwd: os.tmpdir(),
    appsRoot: path.join(os.tmpdir(), 'cybermole-console-events-apps'),
    spawnSession: spawnOk,
    liveSessionNames: async () => new Set(),
    shellCommand: () => cmdOk('shell-cmd'),
    agentCommand: () => cmdOk('agent-cmd'),
  });
}

function apps(db) {
  return new Apps({ db, username: () => USERNAME, killSession: async () => true });
}

/** Always unsubscribes: the bus is a module singleton. */
async function collecting(body) {
  const events = [];
  const off = onDomainEvent(e => events.push(e));
  try {
    await body(events);
  } finally {
    off();
  }
  return events;
}

/** Only the [topic, type] pairs, so payloads don't crowd the assertions. */
const kinds = events => events.map(e => [e.topic, e.type]);

test('workspaces: every mutation publishes; failures and no-ops publish nothing', async () => {
  const db = freshDb();
  const events = await collecting(async () => {
    const w = workspaces(db);

    // create: the workspace plus its auto-opened agent tab
    const made = await w.saveWorkspace({ name: 'alpha' });
    assert.ok(made.ok, made.errorMessage);

    // rename
    assert.ok((await w.updateWorkspace(made.data.id, { name: 'beta' })).ok);

    // a second tab, then rename it, then reorder, then close it
    const tab = await w.newTerminal(made.data.id, 'extra');
    assert.ok(tab.ok, tab.errorMessage);
    assert.ok((await w.renameTerminal(tab.data.id, 'renamed')).ok);
    const agentTab = (await w.workspaceTree()).data.workspaces[0].terminals.find(
      t => t.title === null,
    );
    assert.ok((await w.reorderTerminals(made.data.id, [tab.data.id, agentTab.id])).ok);
    // the same order again writes nothing: no event
    assert.ok((await w.reorderTerminals(made.data.id, [tab.data.id, agentTab.id])).ok);
    assert.ok((await w.closeTerminal(tab.data.id)).ok);

    // delete
    assert.ok((await w.deleteWorkspace(made.data.id)).ok);
  });
  assert.deepEqual(kinds(events), [
    ['workspaces', 'workspace_created'],
    ['workspaces', 'terminal_created'],
    ['workspaces', 'workspace_updated'],
    ['workspaces', 'terminal_created'],
    ['workspaces', 'terminal_renamed'],
    ['workspaces', 'terminals_reordered'],
    ['workspaces', 'terminal_closed'],
    ['workspaces', 'workspace_deleted'],
  ]);
  // payloads name what moved
  const created = events.find(e => e.type === 'workspace_created');
  assert.equal(created.workspaceId, events.find(e => e.type === 'terminal_created').workspaceId);
});

test('workspaces: no-op updates, title-less renames and failures publish nothing', async () => {
  const db = freshDb();
  const w = workspaces(db);
  const made = await w.saveWorkspace({ name: 'alpha' });
  const events = await collecting(async () => {
    // no fields: the early no-op return
    assert.ok((await w.updateWorkspace(made.data.id, {})).ok);
    // undefined title: the read-only return
    const tab = (await w.workspaceTree()).data.workspaces[0].terminals[0];
    assert.ok((await w.renameTerminal(tab.id, undefined)).ok);
    // invalid input and dead rows never reach the write. (Self-naming made a
    // blank create name derive from the cwd — invalid_name is update-only now,
    // so the create failure here is the bad cwd.)
    assert.equal(
      (await w.saveWorkspace({ name: 'x', cwd: '/no/such/dir' })).errorCode,
      'invalid_cwd',
    );
    assert.equal(
      (await w.updateWorkspace(made.data.id, { name: 'x', cwd: '/no/such/dir' })).errorCode,
      'invalid_cwd',
    );
    assert.equal((await w.deleteWorkspace(MISSING_WS)).errorCode, 'workspace_not_found');
  });
  assert.deepEqual(events, []);
});

test('workspaces: a db that cannot open publishes nothing', async () => {
  const events = await collecting(async () => {
    const w = workspaces(brokenDb());
    assert.equal((await w.saveWorkspace({ name: 'alpha' })).errorCode, 'database_error');
    assert.equal((await w.deleteWorkspace(MISSING_WS)).errorCode, 'database_error');
  });
  assert.deepEqual(events, []);
});

test('apps: create/rename/delete publish; duplicate slugs, no-ops and db failures publish nothing', async () => {
  const db = freshDb();
  const events = await collecting(async () => {
    const a = apps(db);
    assert.ok((await a.saveApp('My App')).ok);
    // the slug is taken: never reaches the write
    assert.equal((await a.saveApp('my app')).errorCode, 'duplicate_slug');
    assert.ok((await a.renameApp('my-app', 'Renamed')).ok);
    // no fields: the early no-op return
    assert.ok((await a.renameApp('my-app', undefined, undefined)).ok);
    assert.ok((await a.deleteApp('my-app')).ok);
    assert.equal((await a.deleteApp('my-app')).errorCode, 'app_not_found');
  });
  assert.deepEqual(events, [
    { topic: 'apps', type: 'app_created', slug: 'my-app' },
    { topic: 'apps', type: 'app_updated', slug: 'my-app' },
    { topic: 'apps', type: 'app_deleted', slug: 'my-app' },
  ]);
});

test('apps: a db that cannot open publishes nothing', async () => {
  const events = await collecting(async () => {
    assert.equal((await apps(brokenDb()).saveApp('My App')).errorCode, 'database_error');
  });
  assert.deepEqual(events, []);
});

// ---------- liveness watcher ----------

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const names = (...raw) => new Set(raw);

test('the liveness watcher: silent baseline, publishes on a diff, quiet when unchanged, stops', async () => {
  let live = names('t-one', 'cybermole-nightly');
  const events = await collecting(async seen => {
    const stop = startLivenessWatch({ liveSessionNames: async () => live, intervalMs: 10 });
    await wait(); // the first probe only takes the baseline
    assert.deepEqual(seen, []);
    live = names('t-one'); // a session died
    await wait();
    live = names('t-one'); // unchanged: quiet
    await wait();
    stop();
    live = names(); // everything died after the stop: never published
    await wait();
  });
  assert.deepEqual(events, [{ topic: 'workspaces', type: 'liveness_changed' }]);
});

test('the liveness watcher: a first probe over a down tmux server (empty set) is the baseline', async () => {
  let live = new Set();
  const events = await collecting(async () => {
    const stop = startLivenessWatch({ liveSessionNames: async () => live, intervalMs: 10 });
    await wait();
    live = names('t-one');
    await wait();
    stop();
  });
  assert.deepEqual(events, [{ topic: 'workspaces', type: 'liveness_changed' }]);
});
