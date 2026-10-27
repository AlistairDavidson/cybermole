// sidebar-order.ts: the sidebar's optimistic-order reconciliation — a
// pending order overrides polls until one confirms it (the same ids, in
// order), then prunes itself; rows that appear follow, rows that vanish
// drop out, and other groups keep their place in the flat list.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPendingAppOrder,
  applyPendingWorkspaceOrders,
} from '../../dist-server/src/lib/web/sidebar-order.js';

const W = (n, appId = null) => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  appId,
  name: `w${n}`,
  cwd: '/tmp',
  kind: null,
  order: n * 10,
  terminals: [],
});
const A = (n, slug) => ({
  id: `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  name: `app ${n}`,
  slug,
  cwd: null,
  order: n * 10,
});

const state = (workspaces, apps = []) => ({
  me: 'ok',
  configured: true,
  editor: true,
  defaultCwd: '/tmp',
  apps,
  workspaces,
});

// ---------- workspaces ----------

test('applyPendingWorkspaceOrders: the pending order stands until a poll confirms it', () => {
  const st = state([W(0), W(1), W(2)]);
  const pending = new Map([[null, [W(2).id, W(0).id, W(1).id]]]);
  const out = applyPendingWorkspaceOrders(st, pending);
  assert.deepEqual(
    out.workspaces.map(w => w.name),
    ['w2', 'w0', 'w1'],
  );
  assert.equal(pending.size, 1); // not confirmed yet

  // The poll lands with the written order: confirmed and pruned.
  const confirmed = state([W(2), W(0), W(1)]);
  const out2 = applyPendingWorkspaceOrders(confirmed, pending);
  assert.equal(pending.size, 0);
  assert.equal(out2, confirmed); // untouched, not copied
});

test('applyPendingWorkspaceOrders: new rows follow, vanished rows drop, other groups keep their place', () => {
  const app = '20000000-0000-4000-8000-00000000000a';
  const pending = new Map([[app, [W(3).id, W(1).id]]]);
  // ws2 vanishes and ws5 joins the app's group between the write and the poll
  const poll = state([W(0), W(1, app), W(3, app), W(5, app), W(4)], []);
  const out = applyPendingWorkspaceOrders(poll, pending);
  assert.deepEqual(
    out.workspaces.map(w => w.name),
    ['w0', 'w3', 'w1', 'w5', 'w4'],
  );
  assert.equal(pending.size, 1); // w5 keeps it unconfirmed
});

test('applyPendingWorkspaceOrders: a group gone entirely prunes its pending', () => {
  const app = '20000000-0000-4000-8000-00000000000b';
  const pending = new Map([[app, [W(1).id]]]);
  const out = applyPendingWorkspaceOrders(state([W(0)]), pending);
  assert.equal(pending.size, 0);
  assert.deepEqual(
    out.workspaces.map(w => w.name),
    ['w0'],
  );
});

// ---------- apps ----------

test('applyPendingAppOrder: registered rows follow the pending order; extras ride untouched', () => {
  const st = state([], [A(1, 'alpha'), A(2, 'beta')]);
  // the pending display order may interleave an unregistered tree
  const out = applyPendingAppOrder(st, ['unreg', 'beta', 'alpha']);
  assert.deepEqual(
    out.state.apps.map(a => a.slug),
    ['beta', 'alpha'],
  );
  assert.deepEqual(out.pending, ['unreg', 'beta', 'alpha']);

  // the poll confirms the registered projection: pending nulls, extras trail
  const confirmed = state([], [A(2, 'beta'), A(1, 'alpha')]);
  const out2 = applyPendingAppOrder(confirmed, out.pending);
  assert.equal(out2.pending, null);
  assert.equal(out2.state, confirmed);
});

test('applyPendingAppOrder: a row that appears follows; null passes through', () => {
  assert.equal(applyPendingAppOrder(state([], []), null).pending, null);
  const st = state([], [A(1, 'alpha'), A(2, 'beta')]);
  const out = applyPendingAppOrder(st, ['beta', 'gamma', 'alpha']);
  // gamma never registers; a new app 'delta' appears in the poll
  const poll = state([], [A(1, 'alpha'), A(2, 'beta'), A(3, 'delta')]);
  const out2 = applyPendingAppOrder(poll, out.pending);
  assert.deepEqual(
    out2.state.apps.map(a => a.slug),
    ['beta', 'alpha', 'delta'],
  );
});
