// The sidebar's optimistic-order reconciliation, mirroring terminal-tabs'
// pendingOrder: a reorder moves the display at once and is held as pending
// until a state poll confirms the write (the server's ids, in order). A
// failed write reverts by dropping the pending order. Node-free, so the
// client bundle ships it and the unit tests hit it directly.
import type { AppId, AppSlug, WorkspaceId } from '@cybermole/app-kit';
import type { ConsoleState, WorkspaceState } from '../platform/types';
import { sameSequence } from '../order-plan';

/** Applies the pending workspace orders to a state: each group renders in
 *  its pending order (rows that appeared since follow in server order;
 *  rows that vanished drop out), every other group keeps its place in the
 *  flat list. Entries the server has confirmed — or whose group is gone —
 *  are pruned from the map, so a confirmed order stops overriding polls. */
export function applyPendingWorkspaceOrders(
  st: ConsoleState,
  pending: Map<AppId | null, readonly WorkspaceId[]>,
): ConsoleState {
  let workspaces = st.workspaces;
  for (const [appId, order] of pending) {
    const group = workspaces.filter(w => w.appId === appId);
    const serverIds = group.map(w => w.id);
    if (serverIds.length === 0 || sameSequence(serverIds, order)) {
      pending.delete(appId);
      continue;
    }
    const seen = new Set<WorkspaceId>();
    const reordered: WorkspaceState[] = [];
    for (const id of order) {
      const w = group.find(x => x.id === id);
      if (w) {
        seen.add(id);
        reordered.push(w);
      }
    }
    const merged = [...reordered, ...group.filter(w => !seen.has(w.id))];
    let spliced = false;
    workspaces = workspaces.flatMap(w => {
      if (w.appId !== appId) return [w];
      if (spliced) return [];
      spliced = true;
      return merged;
    });
  }
  return workspaces === st.workspaces ? st : { ...st, workspaces };
}

/** Applies a pending app-group order (it may interleave unregistered
 *  trees, which have no row to persist): registered rows render in the
 *  pending order, rows that appeared since follow. The returned pending is
 *  null once the server's row order matches the pending registered
 *  projection — or nothing is left — so extras fall back to trailing. */
export function applyPendingAppOrder(
  st: ConsoleState,
  pending: readonly AppSlug[] | null,
): { state: ConsoleState; pending: AppSlug[] | null } {
  if (pending === null) return { state: st, pending: null };
  const serverSlugs = st.apps.map(a => a.slug);
  const registered = pending.filter(s => serverSlugs.includes(s));
  if (sameSequence(serverSlugs, registered)) return { state: st, pending: null };
  const seen = new Set<AppSlug>(registered);
  const apps = [
    ...registered.flatMap(s => {
      const found = st.apps.find(a => a.slug === s);
      return found ? [found] : [];
    }),
    ...st.apps.filter(a => !seen.has(a.slug)),
  ];
  return { state: { ...st, apps }, pending: [...pending] };
}
