// <workspace-sidebar>: workspaces grouped by app (the console group first)
// in a wa-tree — groups are parent items, workspaces leaf items — with a
// name filter and create/delete buttons; everything is emitted to
// <console-app>. WorkspaceSidebar.astro SSRs the filter, the tree and + app
// and holds the group/row skeletons; each state push restamps the tree's
// items, so the filter keeps its value and focus untouched. The tree owns
// selection (leaf mode), expand/collapse and arrow-key navigation; group
// expansion is remembered in localStorage and applied at stamp time, so a
// push never flickers groups open.
//
// Scope splits the page (the console-split plan): "console" renders the
// Console group only (orchestration); "builder" renders the app portfolio —
// app groups with lifecycle chips from /api/apps/status, per-group
// + workspace (a build session) and + app at the bottom.
//
// Rows and (on the builder page) app groups reorder by drag or by
// Shift+Arrow on the focused item — the terminal tab bar's affordance
// language; plain arrows stay the tree's. A reorder is optimistic: the display moves at once, the write
// rides signedInFetch straight to /api/*/order (no console-app wiring), and
// the pending order overrides polls until one confirms it; a failed write
// reverts. A push that lands mid-drag is deferred to dragend, so a restamp
// never yanks the dragged node out from under the pointer.
// A name filter hides rows, so reordering waits for a clear view: a
// filtered list can't name a full-group order.
import type { AppServingState, ConsoleState, WorkspaceState } from '../../lib/platform/types';
import type { AppStatusEntry, AppsStatusData } from '../../lib/apps/apps-status';
import {
  asAppSlug,
  asWorkspaceId,
  type AppId,
  type AppSlug,
  type WorkspaceId,
} from '@cybermole/app-kit';
import { BASE } from '../../base';
import { moveItem, sameSequence } from '../../lib/order-plan';
import { DEFAULT_APP_ICON } from '../../lib/apps/app-icons';
import { applyPendingAppOrder, applyPendingWorkspaceOrders } from '../../lib/web/sidebar-order';
import { signedInFetch } from '../signed-in-fetch';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/tree/tree.js';
import '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';

interface WaInputLike extends HTMLElement {
  value: string | null;
}

interface Updatable {
  updateComplete?: Promise<unknown>;
}

/** Focuses a freshly stamped tree item once it renders: a nested item is
 *  only slotted (so focusable) after its parent item's first update. */
function focusWhenRendered(el: HTMLElement | null): void {
  if (!el) return;
  const parent = el.parentElement as (HTMLElement & Updatable) | null;
  void Promise.all([parent?.updateComplete, (el as HTMLElement & Updatable).updateComplete]).then(
    () => {
      if (el.isConnected) el.focus();
    },
  );
}

interface WaSelectionChange extends Event {
  detail: { selection: HTMLElement[] };
}

export type SidebarScope = 'console' | 'builder';

/** What <console-app> hands down per render. appsStatus is null until the
 *  builder scope's first /api/apps/status poll lands; groups then render
 *  from the state rows alone, chips absent. */
export interface SidebarView {
  scope: SidebarScope;
  appsStatus: AppsStatusData | null;
}

// ---- group collapse ----

/** `{ "<slug>": true }` per collapsed group. */
const NAV_COLLAPSED_KEY = 'cybermole:nav-collapsed';
/** An app named "Console" shares this key, so the two collapse together. */
const CONSOLE_GROUP_KEY = 'console';

let collapsedGroups: Set<string> | null = null;

/** Read once. A corrupt value or unusable storage just means nothing is remembered. */
function navCollapsed(): Set<string> {
  if (collapsedGroups) return collapsedGroups;
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(NAV_COLLAPSED_KEY) ?? '{}');
  } catch {
    stored = {};
  }
  const map = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  collapsedGroups = new Set(Object.keys(map).filter(k => map[k] === true));
  return collapsedGroups;
}

function setGroupCollapsed(key: string, collapsed: boolean): void {
  const groups = navCollapsed();
  if (collapsed) groups.add(key);
  else groups.delete(key);
  try {
    const stored: Record<string, true> = {};
    groups.forEach(k => {
      stored[k] = true;
    });
    localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify(stored));
  } catch {
    /* storage unavailable */
  }
}

// ---- the lifecycle chip (builder scope) ----

/** The portfolio's four states; the title (its tooltip) carries the reason. */
function lifecycleChip(entry: AppStatusEntry): { label: string; variant: string; title: string } {
  if (!entry.registered)
    return {
      label: 'unregistered tree',
      variant: 'warning',
      title: 'a scaffolded tree with no row — register it (the apps MCP) to serve it',
    };
  if (!entry.hasManifest)
    return {
      label: 'registered',
      variant: 'neutral',
      title: 'the row exists but no app tree yet — a build session can scaffold it',
    };
  if (!entry.built)
    return {
      label: 'registered',
      variant: 'neutral',
      title: 'registered, not built yet',
    };
  if (entry.buildStale)
    return {
      label: 'stale build',
      variant: 'warning',
      title: 'sources changed since the last build — rebuild',
    };
  return { label: 'built', variant: 'success', title: 'the build is fresh' };
}

export class WorkspaceSidebar extends HTMLElement {
  private selected: WorkspaceId | null = null;
  /** The last poll's state, never optimistically mutated. */
  private server: ConsoleState | null = null;
  /** What renders: the server state plus the pending orders. */
  private state: ConsoleState | null = null;
  private view: SidebarView = { scope: 'console', appsStatus: null };
  private search = '';
  /** Optimistic orders per group (appId null = the console group) until a
   *  poll confirms the write. */
  private readonly pendingWs = new Map<AppId | null, WorkspaceId[]>();
  /** The optimistic app-group order (slugs, unregistered trees included)
   *  until a poll confirms the registered rows' projection. */
  private pendingApps: AppSlug[] | null = null;
  /** The workspace row being dragged, null when no row drag is live. */
  private rowDrag: WorkspaceId | null = null;
  /** The app group being dragged (its slug), null when none is live. */
  private appDrag: AppSlug | null = null;
  /** A render or list swap asked for mid-drag; runs at dragend. */
  private deferred: (() => void) | null = null;
  /** Serializes order writes, so two rapid reorders persist in dispatch
   *  order (each write is a full list; the last one wins). */
  private orderQueue: Promise<void> = Promise.resolve();
  /** Tooltips stamped during a restamp; they join .ws-tips once their
   *  anchors are in the document (a tooltip binds its anchor on connect). */
  private stampedTips: Element[] = [];

  connectedCallback(): void {
    const search = this.querySelector('#workspace-search') as WaInputLike | null;
    search?.addEventListener('input', () => {
      this.search = search.value ?? '';
      this.updateList();
    });
    search?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.search !== '') {
        search.value = '';
        this.search = '';
        this.updateList();
      }
    });
    this.querySelector('#new-app')?.addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('new-app', { bubbles: true, composed: true })),
    );
    const tree = this.querySelector('wa-tree');
    tree?.addEventListener('wa-selection-change', e => {
      const ws = (e as WaSelectionChange).detail.selection[0]?.dataset.ws;
      if (ws === undefined) return;
      this.dispatchEvent(
        new CustomEvent('select-workspace', { detail: { id: ws }, bubbles: true, composed: true }),
      );
    });
    // A filter forces groups open without touching the remembered state.
    const remember = (e: Event): void => {
      const group = e.target as HTMLElement;
      if (!group.matches('.ws-group') || this.search.trim() !== '') return;
      setGroupCollapsed(group.dataset.group ?? '', e.type === 'wa-collapse');
    };
    tree?.addEventListener('wa-expand', remember);
    tree?.addEventListener('wa-collapse', remember);
  }

  render(st: ConsoleState, selected: WorkspaceId | null, view: SidebarView): void {
    if (this.rowDrag !== null || this.appDrag !== null) {
      this.deferred = () => this.render(st, selected, view);
      return;
    }
    this.selected = selected;
    this.view = view;
    this.server = st;
    this.state = this.displayState();
    this.updateList();
  }

  /** Clones a skeleton's single root element from WorkspaceSidebar.astro. */
  private stamp<T extends HTMLElement>(name: string): T {
    const tpl = this.querySelector<HTMLTemplateElement>(`:scope > template[${name}]`)!;
    return document.importNode(tpl.content, true).firstElementChild as T;
  }

  /** The server state with every pending order applied (and confirmed
   *  pendings pruned — their overrides are the server's truth now). */
  private displayState(): ConsoleState {
    const st = this.server;
    if (!st) throw new Error('render before state');
    const withWs = applyPendingWorkspaceOrders(st, this.pendingWs);
    const withApps = applyPendingAppOrder(withWs, this.pendingApps);
    this.pendingApps = withApps.pending;
    return withApps.state;
  }

  /** Re-derives the display state and redraws the groups (not the filter). */
  private redraw(): void {
    if (!this.server) return;
    this.state = this.displayState();
    this.updateList();
  }

  private groups(): HTMLElement[] {
    const st = this.state;
    if (!st) return [];
    if (this.view.scope === 'console') {
      const group = this.groupShell(
        CONSOLE_GROUP_KEY,
        'cybermole',
        'cybermole',
        st.workspaces.filter(w => w.appId === null),
      );
      if (!group) return [];
      // The console group keeps its + workspace (a plain console
      // workspace: appId null, no build framing) — only + app moved to
      // the builder page.
      this.action(group, 'new-ws-btn', 'new workspace in cybermole')?.setAttribute(
        'data-new-ws',
        '',
      );
      for (const cls of ['open-app-btn', 'app-settings-btn', 'del-app-btn'])
        this.action(group, cls, null);
      return [group];
    }
    // The builder page: the portfolio join is the group list (it carries the
    // unregistered trees, exactly where "continue building" is the point);
    // rows it hasn't covered yet (the status poll lagging) still render.
    const entries = this.view.appsStatus?.apps ?? [];
    const groups = st.apps.map(app => ({
      slug: app.slug,
      row: app as AppServingState | null,
      entry: entries.find(e => e.slug === app.slug) ?? null,
    }));
    const extras = entries
      .filter(e => !st.apps.some(a => a.slug === e.slug))
      .map(e => ({ slug: e.slug, row: null as AppServingState | null, entry: e }));
    const combined = [...groups, ...extras];
    if (this.pendingApps !== null) {
      // The optimistic order stands until a poll confirms it, so a dragged
      // group doesn't snap back while its write is in flight.
      const rank = new Map<string, number>(this.pendingApps.map((s, i) => [s, i] as const));
      combined.sort((a, b) => (rank.get(a.slug) ?? Infinity) - (rank.get(b.slug) ?? Infinity));
    }
    return combined.flatMap(g => this.appGroup(g.slug, g.row, g.entry) ?? []);
  }

  /** Pairs a stamped element with its tooltip (data-tip = the element's
   *  class) by a per-group id; text null drops both. */
  private tip(
    scope: HTMLElement,
    cls: string,
    id: string,
    text: string | null,
  ): HTMLElement | null {
    const el = scope.querySelector<HTMLElement>(`.${cls}`);
    const tooltip = scope.querySelector(`:scope > wa-tooltip[data-tip="${cls}"]`);
    if (text === null) {
      el?.remove();
      tooltip?.remove();
      return null;
    }
    if (el) el.id = id;
    if (tooltip) {
      tooltip.setAttribute('for', id);
      tooltip.textContent = text;
      tooltip.remove();
      this.stampedTips.push(tooltip);
    }
    return el;
  }

  /** A group-header action and its tooltip; tip null drops the action. */
  private action(group: HTMLElement, cls: string, tip: string | null): HTMLElement | null {
    const key = group.dataset.group ?? '';
    return this.tip(group, cls, `ws-group-${key}-${cls}`, tip);
  }

  /** A group section from the skeleton. reorderable marks the header itself
   *  as draggable — builder app groups only; workspace rows always reorder
   *  within their group. icon renders ahead of the name and chip after it
   *  (app groups only). null when a filter hides every row. */
  private groupShell(
    key: string,
    name: string,
    title: string,
    workspaces: WorkspaceState[],
    reorderable = false,
    icon = '',
    chip: { label: string; variant: string; title: string } | null = null,
  ): HTMLElement | null {
    const visible = workspaces.filter(w => this.matchesSearch(w));
    if (this.search.trim() && visible.length === 0) return null; // a filter hides empty groups
    // A filter forces groups open without touching stored state, so
    // clearing it restores each group's collapse.
    const collapsed = this.search.trim() === '' && navCollapsed().has(key);
    const group = this.stamp<HTMLElement>('data-group');
    group.dataset.group = key;
    group.toggleAttribute('expanded', !collapsed);
    if (reorderable) {
      group.draggable = true;
      group.setAttribute('aria-keyshortcuts', 'Shift+ArrowUp Shift+ArrowDown');
    }
    // The disabled placeholder keeps an empty group a parent, so leaf
    // selection never makes the group itself selectable.
    if (visible.length) {
      group.querySelector(':scope > .group-empty')?.remove();
      group.append(...visible.map(w => this.row(w)));
    }

    const glyph = group.querySelector('.g-icon')!;
    if (icon === '') glyph.remove();
    else {
      const wa = glyph.querySelector('wa-icon')!;
      wa.setAttribute('name', icon);
      wa.setAttribute('label', name);
    }
    this.tip(group, 'g-name', `ws-group-${key}-name`, title)!.textContent = name;
    const badge = this.tip(group, 'g-chip', `ws-group-${key}-chip`, chip?.title ?? null);
    if (badge && chip) {
      badge.setAttribute('variant', chip.variant);
      badge.textContent = chip.label;
    }
    return group;
  }

  /** A builder-page app group: lifecycle chip, open link (registered only),
   *  + workspace (a build session; needs the row), delete (needs the row). */
  private appGroup(
    slug: string,
    app: AppServingState | null,
    entry: AppStatusEntry | null,
  ): HTMLElement | null {
    const st = this.state;
    const workspaces = st && app ? st.workspaces.filter(w => w.appId === app.id) : [];
    // The row names what the operator sees (rename edits it); a bare tree
    // falls back to its manifest's name.
    const name = app?.name ?? entry?.name ?? slug;
    // The app's cwd shows in the header's tooltip.
    const title = app?.cwd ? `${name} — build sessions are framed at ${app.cwd}` : name;
    // The row's icon wins (the picker's write), else the manifest's (a
    // scaffolded tree shows its icon before it registers), else the default.
    const icon = app?.icon ?? entry?.icon ?? DEFAULT_APP_ICON;
    // Only a group with a row persists an order; an unregistered tree is
    // the portfolio's stationary invitation.
    const chip = entry === null ? null : lifecycleChip(entry);
    const group = this.groupShell(slug, name, title, workspaces, app !== null, icon, chip);
    if (!group) return null;

    if (!app) {
      for (const cls of ['new-ws-btn', 'open-app-btn', 'app-settings-btn', 'del-app-btn'])
        this.action(group, cls, null);
      return group;
    }
    this.action(group, 'new-ws-btn', `new build workspace for ${name}`)?.setAttribute(
      'data-new-ws',
      app.id,
    );
    // Not serving only dims the link, with the reason as its tooltip; it's
    // still clickable.
    const open = this.action(
      group,
      'open-app-btn',
      app.serving
        ? `open ${name}`
        : `${name} is not serving: ${app.servingReason ?? 'the app host is down'}`,
    );
    open?.setAttribute('href', `${BASE}/apps/${slug}/`);
    open?.classList.toggle('not-serving', !app.serving);
    open?.querySelector('wa-icon')?.setAttribute('label', `open ${name}`);
    // The settings page (the picker lives there); a row is addressable, a
    // bare tree is not.
    const settings = this.action(group, 'app-settings-btn', `settings for ${name}`);
    settings?.setAttribute('href', `${BASE}/builder/${slug}`);
    settings?.querySelector('wa-icon')?.setAttribute('label', `settings for ${name}`);
    this.action(group, 'del-app-btn', `delete the app ${name} (and its workspaces)`)?.setAttribute(
      'data-del-app',
      slug,
    );
    return group;
  }

  private row(w: WorkspaceState): HTMLElement {
    const li = this.stamp<HTMLElement>('data-row');
    li.dataset.ws = w.id;
    li.toggleAttribute('selected', w.id === this.selected);
    li.querySelector('.t-name')!.textContent = w.name;
    // The cwd ellipsizes; its tooltip carries the whole path.
    this.tip(li, 'd', `ws-row-${w.id}-cwd`, w.cwd)!.textContent = w.cwd;
    this.tip(
      li,
      'del-ws-btn',
      `ws-row-${w.id}-del`,
      `delete the workspace ${w.name} (and its terminals)`,
    )?.setAttribute('data-del-ws', w.id);
    return li;
  }

  /** Name only: a cwd match would light up every workspace sharing a root. */
  private matchesSearch(w: WorkspaceState): boolean {
    const q = this.search.trim().toLowerCase();
    return !q || w.name.toLowerCase().includes(q);
  }

  /** Restamps the groups; the filter input is SSR'd and never touched. */
  private updateList(): void {
    if (this.rowDrag !== null || this.appDrag !== null) {
      this.deferred = () => this.updateList();
      return;
    }
    const host = this.querySelector('.ws-groups');
    if (!host) return;
    const focus = this.capturedRowFocus();
    this.stampedTips = [];
    host.replaceChildren(...this.groups());
    this.querySelector('.ws-tips')?.replaceChildren(...this.stampedTips);
    this.wireRows();
    this.restoreRowFocus(focus);
  }

  /** Called after both render() and updateList(). */
  private wireRows(): void {
    // The header's actions act; they never also toggle the group.
    this.querySelectorAll<HTMLElement>('.g-actions wa-button').forEach(el => {
      el.onclick = e => e.stopPropagation();
    });
    this.querySelectorAll<HTMLElement>('[data-new-ws]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        this.dispatchEvent(
          new CustomEvent('new-workspace', {
            detail: { appId: el.dataset.newWs || null },
            bubbles: true,
            composed: true,
          }),
        );
      };
    });
    this.querySelectorAll<HTMLElement>('wa-tree-item[data-ws]').forEach(el => {
      this.wireRowReorder(el);
    });
    this.querySelectorAll<HTMLElement>('[data-del-ws]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation(); // the row selects; the button deletes
        const w = (this.state?.workspaces ?? []).find(x => x.id === el.dataset.delWs);
        if (w)
          this.dispatchEvent(
            new CustomEvent('delete-workspace', {
              detail: { id: w.id, name: w.name },
              bubbles: true,
              composed: true,
            }),
          );
      };
    });
    this.querySelectorAll<HTMLElement>('[data-del-app]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        const app = (this.state?.apps ?? []).find(a => a.slug === el.dataset.delApp);
        if (app)
          this.dispatchEvent(
            new CustomEvent('delete-app', {
              detail: { slug: app.slug, name: app.name },
              bubbles: true,
              composed: true,
            }),
          );
      };
    });
    this.wireGroupReorder();
  }

  // ---- reorder: shared ----

  /** Which row/header held focus before a swap, so a poll never drops it. */
  private capturedRowFocus(): { ws: WorkspaceId | null; group: AppSlug | null } {
    const active =
      document.activeElement instanceof HTMLElement && this.contains(document.activeElement)
        ? document.activeElement
        : null;
    const ws = active?.closest('wa-tree-item[data-ws]')?.getAttribute('data-ws') ?? null;
    const group =
      active?.matches('.ws-group') === true
        ? ((active.getAttribute('data-group') ?? null) as AppSlug | null)
        : null;
    return { ws: ws === null ? null : asWorkspaceId(ws), group };
  }

  private restoreRowFocus(focus: { ws: WorkspaceId | null; group: AppSlug | null }): void {
    if (focus.ws !== null) focusWhenRendered(this.rowEl(focus.ws));
    else if (focus.group !== null) focusWhenRendered(this.groupSection(focus.group));
  }

  private runDeferred(): void {
    const deferred = this.deferred;
    this.deferred = null;
    deferred?.();
  }

  /** Serializes order writes; each write is a full list, so the last one
   *  kept by the server is the newest dispatch. */
  private queueOrder(run: () => Promise<void>): void {
    this.orderQueue = this.orderQueue.then(run).then(
      () => undefined,
      () => undefined,
    );
  }

  // ---- reorder: workspace rows ----

  private rowEl(id: WorkspaceId): HTMLElement | null {
    return this.querySelector(`wa-tree-item[data-ws="${id}"]`);
  }

  private appIdOf(id: WorkspaceId): AppId | null {
    return this.state?.workspaces.find(w => w.id === id)?.appId ?? null;
  }

  /** The row's group's ids in display order. */
  private groupIds(id: WorkspaceId): WorkspaceId[] {
    const st = this.state;
    const appId = this.appIdOf(id);
    return st ? st.workspaces.filter(w => w.appId === appId).map(w => w.id) : [];
  }

  private wireRowReorder(el: HTMLElement): void {
    const id = asWorkspaceId(el.dataset.ws ?? '');
    // A filtered view can't name a full-group order, so rows stop dragging.
    el.draggable = this.search.trim() === '';
    el.addEventListener('dragstart', e => this.onRowDragStart(id, e));
    el.addEventListener('dragover', e => this.onRowDragOver(id, e));
    el.addEventListener('drop', e => this.onRowDrop(e));
    el.addEventListener('dragend', () => this.onRowDragEnd(id));
    el.addEventListener('keydown', e => this.onRowKeydown(id, e));
  }

  private onRowDragStart(id: WorkspaceId, e: DragEvent): void {
    e.stopPropagation(); // the group item around it drags too
    this.rowDrag = id;
    // Data is required for Firefox to start a drag at all.
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    this.rowEl(id)?.classList.add('dragging');
  }

  private onRowDragOver(over: WorkspaceId, e: DragEvent): void {
    const dragged = this.rowDrag;
    if (dragged === null) return;
    // Every row is a drop target, the dragged one too: dropping on itself
    // keeps the preview position (dragend alone would snap it back).
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (dragged === over) return;
    const draggedEl = this.rowEl(dragged);
    const overEl = this.rowEl(over);
    const group = draggedEl?.parentElement;
    // Rows stay in their group: cross-group moves are a different act.
    if (!draggedEl || !overEl || !group || overEl.parentElement !== group) return;
    const rect = overEl.getBoundingClientRect();
    const reference = e.clientY > rect.top + rect.height / 2 ? overEl.nextSibling : overEl;
    if (draggedEl !== reference && draggedEl.nextSibling !== reference)
      group.insertBefore(draggedEl, reference);
  }

  private onRowDrop(e: DragEvent): void {
    if (this.rowDrag === null) return;
    e.preventDefault();
    this.finishRowDrag();
  }

  private onRowDragEnd(id: WorkspaceId): void {
    if (this.rowDrag !== null) {
      // No drop: the preview moved the row, so snap the list back.
      this.rowDrag = null;
      this.updateList();
    }
    this.rowEl(id)?.classList.remove('dragging');
    this.runDeferred();
  }

  private finishRowDrag(): void {
    const id = this.rowDrag;
    this.rowDrag = null;
    const el = id === null ? null : this.rowEl(id);
    el?.classList.remove('dragging');
    if (id === null || !el) return;
    const group = el.parentElement;
    if (!group) return;
    const ids: WorkspaceId[] = [];
    for (const li of group.querySelectorAll(':scope > wa-tree-item[data-ws]')) {
      const ws = (li as HTMLElement).dataset.ws;
      if (ws !== undefined) ids.push(asWorkspaceId(ws));
    }
    if (!sameSequence(ids, this.groupIds(id))) this.applyWsOrder(this.appIdOf(id), ids);
  }

  /** Shift+Arrow moves the focused row — the keyboard half of
   *  drag-reorder. Plain arrows are the tree's navigation. */
  private onRowKeydown(id: WorkspaceId, e: KeyboardEvent): void {
    if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.target !== this.rowEl(id)) return;
    e.preventDefault();
    e.stopPropagation(); // or the tree moves focus too
    if (this.search.trim() !== '') return;
    const ids = this.groupIds(id);
    const from = ids.indexOf(id);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= ids.length) return;
    this.applyWsOrder(this.appIdOf(id), moveItem(ids, from, to));
    // The redraw swapped the DOM; keep focus where the user is looking.
    focusWhenRendered(this.rowEl(id));
  }

  private applyWsOrder(appId: AppId | null, ids: WorkspaceId[]): void {
    this.pendingWs.set(appId, ids);
    this.redraw();
    this.queueOrder(() => this.persistWsOrder(appId, ids));
  }

  private async persistWsOrder(appId: AppId | null, ids: readonly WorkspaceId[]): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/workspaces/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ids }),
    });
    if (!sent.ok) return this.revertWsOrder(appId, ids); // signed_out/network: the next render shows the server truth
    if (!sent.data.response.ok) this.revertWsOrder(appId, ids);
  }

  private revertWsOrder(appId: AppId | null, ids: readonly WorkspaceId[]): void {
    const current = this.pendingWs.get(appId);
    // A newer drag superseded this write; its pending order stays.
    if (current === undefined || !sameSequence(current, ids)) return;
    this.pendingWs.delete(appId);
    this.redraw();
  }

  // ---- reorder: app groups (builder) ----

  private groupSection(slug: AppSlug): HTMLElement | null {
    return this.querySelector(`.ws-group[data-group="${slug}"]`);
  }

  /** The group slugs in display order (sections in the nav). */
  private groupSlugs(): AppSlug[] {
    return [...this.querySelectorAll('.ws-groups > .ws-group')].map(g =>
      asAppSlug(g.getAttribute('data-group') ?? ''),
    );
  }

  private wireGroupReorder(): void {
    if (this.view.scope !== 'builder') return;
    this.querySelectorAll<HTMLElement>('.ws-groups > .ws-group').forEach(group => {
      const slug = asAppSlug(group.dataset.group ?? '');
      group.addEventListener('dragstart', e => this.onGroupDragStart(slug, e));
      group.addEventListener('dragover', e => this.onGroupDragOver(slug, e));
      group.addEventListener('drop', e => this.onGroupDrop(e));
      group.addEventListener('dragend', () => this.onGroupDragEnd(slug));
      group.addEventListener('keydown', e => this.onGroupKeydown(slug, e));
    });
  }

  private onGroupDragStart(slug: AppSlug, e: DragEvent): void {
    // The group carries draggable only with a row; a filtered view hides
    // groups, so a partial section list can't name a full order either.
    if (this.search.trim() !== '') {
      e.preventDefault();
      return;
    }
    this.appDrag = slug;
    e.dataTransfer?.setData('text/plain', slug);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    this.groupSection(slug)?.classList.add('dragging');
  }

  private onGroupDragOver(over: AppSlug, e: DragEvent): void {
    const dragged = this.appDrag;
    if (dragged === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (dragged === over) return;
    const nav = this.querySelector('.ws-groups');
    const draggedSec = this.groupSection(dragged);
    const overSec = this.groupSection(over);
    if (!nav || !draggedSec || !overSec) return;
    // The header line, not the whole item (its rows are inside it).
    const rect = overSec.querySelector(':scope > .ws-label')?.getBoundingClientRect();
    if (!rect) return;
    const reference = e.clientY > rect.top + rect.height / 2 ? overSec.nextSibling : overSec;
    if (draggedSec !== reference && draggedSec.nextSibling !== reference)
      nav.insertBefore(draggedSec, reference);
  }

  private onGroupDrop(e: DragEvent): void {
    if (this.appDrag === null) return;
    e.preventDefault();
    this.finishGroupDrag();
  }

  private onGroupDragEnd(slug: AppSlug): void {
    if (this.appDrag !== null) {
      // No drop: the preview moved the section, so snap the groups back.
      this.appDrag = null;
      this.updateList();
    }
    this.groupSection(slug)?.classList.remove('dragging');
    this.runDeferred();
  }

  private finishGroupDrag(): void {
    const slug = this.appDrag;
    this.appDrag = null;
    if (slug !== null) this.groupSection(slug)?.classList.remove('dragging');
    if (slug === null) return;
    const slugs = this.groupSlugs();
    const bySlug = new Map((this.server?.apps ?? []).map(a => [a.slug, a.id] as const));
    const serverIds = (this.server?.apps ?? []).map(a => a.id);
    const ids = slugs.flatMap(s => {
      const id = bySlug.get(s);
      return id ? [id] : [];
    });
    // Only the registered projection persists; an extras-only shuffle is a
    // visual no-op the next poll would drop anyway.
    if (!sameSequence(ids, serverIds)) this.applyAppOrder(slugs, ids);
    else this.redraw();
  }

  /** Shift+Arrow moves the focused group — the keyboard half of
   *  drag-reorder. Plain arrows are the tree's navigation. */
  private onGroupKeydown(slug: AppSlug, e: KeyboardEvent): void {
    if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.target !== this.groupSection(slug)) return;
    e.preventDefault();
    e.stopPropagation(); // or the tree moves focus too
    if (this.search.trim() !== '') return;
    const slugs = this.groupSlugs();
    const from = slugs.indexOf(slug);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= slugs.length) return;
    const moved = moveItem(slugs, from, to);
    const bySlug = new Map((this.server?.apps ?? []).map(a => [a.slug, a.id] as const));
    const ids = moved.flatMap(s => {
      const id = bySlug.get(s);
      return id ? [id] : [];
    });
    this.applyAppOrder(moved, ids);
    focusWhenRendered(this.groupSection(slug));
  }

  private applyAppOrder(slugs: AppSlug[], ids: AppId[]): void {
    this.pendingApps = slugs;
    this.redraw();
    this.queueOrder(() => this.persistAppOrder(slugs, ids));
  }

  private async persistAppOrder(slugs: readonly AppSlug[], ids: readonly AppId[]): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/apps/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ids }),
    });
    if (!sent.ok) return this.revertAppOrder(slugs);
    if (!sent.data.response.ok) this.revertAppOrder(slugs);
  }

  private revertAppOrder(slugs: readonly AppSlug[]): void {
    const current = this.pendingApps;
    if (current === null || !sameSequence(current, slugs)) return;
    this.pendingApps = null;
    this.redraw();
  }
}

if (!customElements.get('workspace-sidebar'))
  customElements.define('workspace-sidebar', WorkspaceSidebar);
