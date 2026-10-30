// <workspace-sidebar>: workspaces grouped by app (the console group first),
// a name filter, and create/delete buttons; everything is emitted to
// <console-app>. It re-renders via innerHTML on the 15 s poll, so the
// filter's value, focus and caret are carried across, and no stateful wa-*
// lives in here. Group collapse state lives in localStorage and is applied
// at render, so a poll never flickers groups open.
//
// Scope splits the page (the console-split plan): "console" renders the
// Console group only (orchestration); "builder" renders the app portfolio —
// app groups with lifecycle chips from /api/apps/status, per-group
// + workspace (a build session) and + app at the bottom.
//
// Rows and (on the builder page) app groups reorder by drag or by
// Shift+Arrow on the focused row/header — the terminal tab bar's affordance
// language. A reorder is optimistic: the display moves at once, the write
// rides signedInFetch straight to /api/*/order (no console-app wiring), and
// the pending order overrides polls until one confirms it; a failed write
// reverts. A poll that lands mid-drag is deferred to dragend, so the
// innerHTML swap never yanks the dragged node out from under the pointer.
// A name filter hides rows, so reordering waits for a clear view: a
// filtered list can't name a full-group order.
import type { AppServingState, ConsoleState, WorkspaceState } from '../lib/platform/types';
import type { AppStatusEntry, AppsStatusData } from '../lib/apps/apps-status';
import {
  asAppSlug,
  asWorkspaceId,
  type AppId,
  type AppSlug,
  type WorkspaceId,
} from '@cybermole/app-kit';
import { BASE } from '../base';
import { moveItem, sameSequence } from '../lib/order-plan';
import { DEFAULT_APP_ICON } from '../lib/apps/app-icons';
import { applyPendingAppOrder, applyPendingWorkspaceOrders } from '../lib/web/sidebar-order';
import { signedInFetch } from './signed-in-fetch';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { esc } from './html';

interface WaInputLike extends HTMLElement {
  value: string;
  focus(options?: FocusOptions): void;
  setSelectionRange(start: number, end: number): void;
}

export type SidebarScope = 'console' | 'builder';

/** What <console-app> hands down per render. appsStatus is null until the
 *  builder scope's first /api/apps/status poll lands; groups then render
 *  from the state rows alone, chips absent. */
export interface SidebarView {
  scope: SidebarScope;
  appsStatus: AppsStatusData | null;
}

function caretOf(el: WaInputLike): number | null {
  const native =
    (el as unknown as { input?: HTMLInputElement }).input ??
    el.shadowRoot?.querySelector('input') ??
    null;
  return native ? native.selectionStart : null;
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

/** The portfolio's four states; the title carries the reason. */
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

  render(st: ConsoleState, selected: WorkspaceId | null, view: SidebarView): void {
    if (this.rowDrag !== null || this.appDrag !== null) {
      this.deferred = () => this.render(st, selected, view);
      return;
    }
    this.selected = selected;
    this.view = view;
    this.server = st;
    this.state = this.displayState();
    const prevSearch = this.querySelector('#workspace-search') as WaInputLike | null;
    if (prevSearch) this.search = prevSearch.value;
    const searchFocused = prevSearch !== null && document.activeElement === prevSearch;
    const searchCaret = searchFocused && prevSearch ? caretOf(prevSearch) : null;
    const focus = this.capturedRowFocus();
    // + app lives on the builder page (the portfolio's privileged act of
    // making a row); the console teaches orchestration only.
    const newApp =
      view.scope === 'builder'
        ? `<wa-button id="new-app" class="new-app" appearance="plain" size="s" data-drawer="close">
          <wa-icon slot="start" name="plus"></wa-icon>new app
        </wa-button>`
        : '';
    this.innerHTML = `
      <nav class="nav">
        <wa-input id="workspace-search" class="workspace-search" placeholder="filter workspaces…" size="s">
          <wa-icon slot="start" name="magnifying-glass"></wa-icon>
        </wa-input>
        ${this.groups()}
        ${newApp}
      </nav>`;
    const searchInput = this.querySelector('#workspace-search') as WaInputLike | null;
    if (searchInput) {
      searchInput.value = this.search;
      if (searchFocused) {
        // After wa-input's first render: its focus/selection forward to an
        // inner input Lit builds on a microtask.
        requestAnimationFrame(() => {
          searchInput.focus();
          if (searchCaret !== null) searchInput.setSelectionRange(searchCaret, searchCaret);
        });
      }
      searchInput.addEventListener('input', () => {
        this.search = searchInput.value;
        this.updateList();
      });
      searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.search !== '') {
          searchInput.value = '';
          this.search = '';
          this.updateList();
        }
      });
    }
    const newAppBtn = this.querySelector('#new-app') as HTMLElement | null;
    if (newAppBtn)
      newAppBtn.onclick = () =>
        this.dispatchEvent(new CustomEvent('new-app', { bubbles: true, composed: true }));
    this.wireRows();
    this.restoreRowFocus(focus);
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

  private groups(): string {
    const st = this.state;
    if (!st) return '';
    if (this.view.scope === 'console')
      return this.groupShell(
        CONSOLE_GROUP_KEY,
        'cybermole',
        'cybermole',
        st.workspaces.filter(w => w.appId === null),
        // The console group keeps its + workspace (a plain console
        // workspace: appId null, no build framing) — only + app moved to
        // the builder page.
        `<wa-button class="new-ws-btn" data-new-ws="" size="xs" appearance="plain" ` +
          `title="new workspace in cybermole"><wa-icon name="plus" label="new workspace"></wa-icon></wa-button>`,
      );
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
    return combined.map(g => this.appGroup(g.slug, g.row, g.entry)).join('');
  }

  /** The console page's single group (console workspaces). reorderable
   *  marks the group header itself as draggable — builder app groups only;
   *  workspace rows always reorder within their group. icon renders ahead
   *  of the name (app groups only). */
  private groupShell(
    key: string,
    name: string,
    title: string,
    workspaces: WorkspaceState[],
    actions = '',
    chip = '',
    reorderable = false,
    icon = '',
  ): string {
    const visible = workspaces.filter(w => this.matchesSearch(w));
    if (this.search.trim() && visible.length === 0) return ''; // a filter hides empty groups
    // A filter forces groups open without touching stored state, so
    // clearing it restores each group's collapse.
    const collapsed = this.search.trim() === '' && navCollapsed().has(key);
    const rowsId = `ws-group-rows-${key}`;
    const hide = collapsed ? ' hidden' : '';
    const rows = visible.length
      ? `<ul class="ws-group-rows" id="${rowsId}"${hide}>${visible.map(w => this.row(w)).join('')}</ul>`
      : `<p class="ws-group-rows group-empty" id="${rowsId}"${hide}>no workspaces yet</p>`;
    const glyph =
      icon === ''
        ? ''
        : `<span class="g-icon"><wa-icon name="${esc(icon)}" label="${esc(name)}"></wa-icon></span>`;
    return (
      `<section class="ws-group" data-group="${esc(key)}">` +
      `<h2${reorderable ? ' draggable="true" aria-keyshortcuts="Shift+ArrowUp Shift+ArrowDown"' : ''}>` +
      `<button type="button" class="g-collapse" data-toggle-group="${esc(key)}" ` +
      `aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${rowsId}" ` +
      `aria-label="${esc(name)} workspaces">` +
      `<wa-icon name="chevron-down"></wa-icon></button>` +
      glyph +
      `<span class="g-name" title="${esc(title)}">${esc(name)}</span>` +
      chip +
      `<span class="g-actions">` +
      actions +
      `</span></h2>${rows}</section>`
    );
  }

  /** A builder-page app group: lifecycle chip, open link (registered only),
   *  + workspace (a build session; needs the row), delete (needs the row). */
  private appGroup(
    slug: string,
    app: AppServingState | null,
    entry: AppStatusEntry | null,
  ): string {
    const st = this.state;
    const workspaces = st && app ? st.workspaces.filter(w => w.appId === app.id) : [];
    // The row names what the operator sees (rename edits it); a bare tree
    // falls back to its manifest's name.
    const name = app?.name ?? entry?.name ?? slug;
    // A plain <a> (no stateful wa-*). Not serving only dims it, with the
    // reason as tooltip; it's still clickable.
    const open = app
      ? `<a class="open-app-btn${app.serving ? '' : ' not-serving'}" ` +
        `href="${BASE}/apps/${esc(slug)}/" ` +
        `title="${esc(app.serving ? `open ${name}` : `${name} is not serving: ${app.servingReason ?? 'the app host is down'}`)}">` +
        `<wa-icon name="arrow-right" label="open ${esc(name)}"></wa-icon></a>`
      : '';
    // The settings page (the picker lives there); a row is addressable, a
    // bare tree is not.
    const settings = app
      ? `<a class="app-settings-btn" href="${BASE}/builder/${esc(slug)}" ` +
        `title="settings for ${esc(name)}">` +
        `<wa-icon name="gear" label="settings for ${esc(name)}"></wa-icon></a>`
      : '';
    const del = app
      ? `<wa-button class="del-app-btn" data-del-app="${esc(slug)}" size="xs" appearance="plain" ` +
        `title="delete the app ${esc(name)} (and its workspaces)">` +
        `<wa-icon name="trash-can" label="delete app"></wa-icon></wa-button>`
      : '';
    const actions =
      (app
        ? `<wa-button class="new-ws-btn" data-new-ws="${esc(app.id)}" size="xs" appearance="plain" ` +
          `title="new build workspace for ${esc(name)}"><wa-icon name="plus" label="new workspace"></wa-icon></wa-button>`
        : '') +
      open +
      settings +
      del;
    const chip =
      entry !== null
        ? (() => {
            const c = lifecycleChip(entry);
            return (
              `<wa-badge class="g-chip" pill variant="${c.variant}" title="${esc(c.title)}">` +
              `${esc(c.label)}</wa-badge>`
            );
          })()
        : '';
    // The app's cwd shows in the header's tooltip.
    const title = app?.cwd ? `${name} — build sessions are framed at ${app.cwd}` : name;
    // The row's icon wins (the picker's write), else the manifest's (a
    // scaffolded tree shows its icon before it registers), else the default.
    const icon = app?.icon ?? entry?.icon ?? DEFAULT_APP_ICON;
    // Only a group with a row persists an order; an unregistered tree is
    // the portfolio's stationary invitation.
    return this.groupShell(slug, name, title, workspaces, actions, chip, app !== null, icon);
  }

  private row(w: WorkspaceState): string {
    const cls = w.id === this.selected ? ' class="active"' : '';
    // No live badge: the tab count is the row's one number, liveness stays
    // on the tab dots (a green pill per row read as a notification).
    return (
      `<li${cls} data-ws="${esc(w.id)}" data-drawer="close" title="${esc(w.cwd)}" ` +
      `aria-keyshortcuts="Shift+ArrowUp Shift+ArrowDown">` +
      `<span class="row-main">` +
      `<span class="t"><wa-icon name="folder"></wa-icon><span class="t-name">${esc(w.name)}</span></span>` +
      `<span class="d">${esc(w.cwd)}</span>` +
      `</span>` +
      `<span class="row-actions">` +
      (w.terminals.length
        ? `<span class="ws-count" title="${w.terminals.length} terminal tab${w.terminals.length === 1 ? '' : 's'}">${w.terminals.length}</span>`
        : '') +
      `<wa-button class="del-ws-btn" data-del-ws="${esc(w.id)}" size="xs" appearance="plain" ` +
      `title="delete the workspace ${esc(w.name)} (and its terminals)">` +
      `<wa-icon name="trash-can" label="delete workspace"></wa-icon></wa-button>` +
      `</span></li>`
    );
  }

  /** Name only: a cwd match would light up every workspace sharing a root. */
  private matchesSearch(w: WorkspaceState): boolean {
    const q = this.search.trim().toLowerCase();
    return !q || w.name.toLowerCase().includes(q);
  }

  /** Leaves the filter input alone, so focus and caret survive typing. */
  private updateList(): void {
    if (this.rowDrag !== null || this.appDrag !== null) {
      this.deferred = () => this.updateList();
      return;
    }
    const nav = this.querySelector('.nav');
    if (!nav) return;
    const focus = this.capturedRowFocus();
    nav.querySelectorAll('.ws-group').forEach(g => g.remove());
    const html = this.groups();
    // #new-app (builder scope) follows the groups; on the console page the
    // groups land at the nav's end.
    const anchor = this.querySelector('#new-app');
    if (anchor) anchor.insertAdjacentHTML('beforebegin', html);
    else nav.insertAdjacentHTML('beforeend', html);
    this.wireRows();
    this.restoreRowFocus(focus);
  }

  /** Called after both render() and updateList(). */
  private wireRows(): void {
    this.querySelectorAll<HTMLElement>('[data-toggle-group]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        const key = el.dataset.toggleGroup ?? '';
        const collapsed = !navCollapsed().has(key);
        setGroupCollapsed(key, collapsed);
        // Flip in place, exactly as the next render would, so focus stays on the button.
        el.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        const rows = el.closest('.ws-group')?.querySelector('.ws-group-rows');
        if (collapsed) rows?.setAttribute('hidden', '');
        else rows?.removeAttribute('hidden');
      };
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
    this.querySelectorAll<HTMLElement>('[data-ws]').forEach(el => {
      el.onclick = () =>
        this.dispatchEvent(
          new CustomEvent('select-workspace', {
            detail: { id: el.dataset.ws },
            bubbles: true,
            composed: true,
          }),
        );
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
    this.applyRovingTabindex();
  }

  // ---- reorder: shared ----

  /** Which row/header held focus before a swap, so a poll never drops it. */
  private capturedRowFocus(): { ws: WorkspaceId | null; group: AppSlug | null } {
    const active =
      document.activeElement instanceof HTMLElement && this.contains(document.activeElement)
        ? document.activeElement
        : null;
    const ws = active?.closest('li[data-ws]')?.getAttribute('data-ws') ?? null;
    const group =
      active?.matches('.ws-group > h2') === true
        ? ((active.closest('.ws-group')?.getAttribute('data-group') ?? null) as AppSlug | null)
        : null;
    return { ws: ws === null ? null : asWorkspaceId(ws), group };
  }

  private restoreRowFocus(focus: { ws: WorkspaceId | null; group: AppSlug | null }): void {
    if (focus.ws !== null) this.rowEl(focus.ws)?.focus();
    else if (focus.group !== null) this.groupH2(focus.group)?.focus();
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

  private rowEl(id: WorkspaceId): HTMLLIElement | null {
    return this.querySelector(`li[data-ws="${id}"]`);
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
    const ul = draggedEl?.closest('ul');
    // Rows stay in their group: cross-group moves are a different act.
    if (!draggedEl || !overEl || !ul || overEl.closest('ul') !== ul) return;
    const rect = overEl.getBoundingClientRect();
    const reference = e.clientY > rect.top + rect.height / 2 ? overEl.nextSibling : overEl;
    if (draggedEl !== reference && draggedEl.nextSibling !== reference)
      ul.insertBefore(draggedEl, reference);
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
    const ul = el.closest('ul');
    if (!ul) return;
    const ids: WorkspaceId[] = [];
    for (const li of ul.querySelectorAll('li[data-ws]')) {
      const ws = (li as HTMLElement).dataset.ws;
      if (ws !== undefined) ids.push(asWorkspaceId(ws));
    }
    if (!sameSequence(ids, this.groupIds(id))) this.applyWsOrder(this.appIdOf(id), ids);
  }

  /** Arrows walk the group's rows (roving focus, wrapping); Shift+Arrow
   *  moves the focused row itself — the keyboard half of drag-reorder. */
  private onRowKeydown(id: WorkspaceId, e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const ids = this.groupIds(id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    const delta = e.key === 'ArrowUp' ? -1 : 1;
    if (e.shiftKey) {
      if (this.search.trim() !== '') return;
      const to = from + delta;
      if (to < 0 || to >= ids.length) return;
      this.applyWsOrder(this.appIdOf(id), moveItem(ids, from, to));
      // The redraw swapped the DOM; keep focus where the user is looking.
      this.rowEl(id)?.focus();
    } else {
      const next = ids[(from + delta + ids.length) % ids.length]!;
      const el = this.rowEl(next);
      el?.focus();
      if (el) this.roveRows(el);
    }
  }

  /** One tab stop in the row's group: the given row, the rest -1. */
  private roveRows(on: HTMLElement): void {
    const ul = on.closest('ul');
    ul?.querySelectorAll<HTMLElement>('li[data-ws]').forEach(li => {
      li.tabIndex = li === on ? 0 : -1;
    });
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

  private groupH2(slug: AppSlug): HTMLElement | null {
    return this.groupSection(slug)?.querySelector('h2') ?? null;
  }

  /** The group slugs in display order (sections in the nav). */
  private groupSlugs(): AppSlug[] {
    return [...this.querySelectorAll('.nav .ws-group')].map(g =>
      asAppSlug(g.getAttribute('data-group') ?? ''),
    );
  }

  private wireGroupReorder(): void {
    if (this.view.scope !== 'builder') return;
    this.querySelectorAll<HTMLElement>('.ws-group > h2').forEach(h2 => {
      const slug = h2.closest('.ws-group')?.getAttribute('data-group') ?? '';
      h2.addEventListener('dragstart', e => this.onGroupDragStart(asAppSlug(slug), e));
      h2.addEventListener('dragover', e => this.onGroupDragOver(asAppSlug(slug), e));
      h2.addEventListener('drop', e => this.onGroupDrop(e));
      h2.addEventListener('dragend', () => this.onGroupDragEnd(asAppSlug(slug)));
      h2.addEventListener('keydown', e => this.onGroupKeydown(asAppSlug(slug), e));
    });
  }

  private onGroupDragStart(slug: AppSlug, e: DragEvent): void {
    // The h2 carries draggable only with a row; a filtered view hides
    // groups, so a partial section list can't name a full order either.
    if (this.search.trim() !== '') {
      e.preventDefault();
      return;
    }
    this.appDrag = slug;
    e.dataTransfer?.setData('text/plain', slug);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    this.groupH2(slug)?.classList.add('dragging');
  }

  private onGroupDragOver(over: AppSlug, e: DragEvent): void {
    const dragged = this.appDrag;
    if (dragged === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (dragged === over) return;
    const nav = this.querySelector('.nav');
    const draggedSec = this.groupSection(dragged);
    const overSec = this.groupSection(over);
    if (!nav || !draggedSec || !overSec) return;
    const rect = overSec.querySelector('h2')?.getBoundingClientRect();
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
    this.groupH2(slug)?.classList.remove('dragging');
    this.runDeferred();
  }

  private finishGroupDrag(): void {
    const slug = this.appDrag;
    this.appDrag = null;
    this.groupH2(slug!)?.classList.remove('dragging');
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

  /** Arrows walk the group headers (roving focus, wrapping); Shift+Arrow
   *  moves the focused group — the keyboard half of drag-reorder. */
  private onGroupKeydown(slug: AppSlug, e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const slugs = this.groupSlugs();
    const from = slugs.indexOf(slug);
    if (from < 0) return;
    const delta = e.key === 'ArrowUp' ? -1 : 1;
    if (e.shiftKey) {
      if (this.search.trim() !== '') return;
      const to = from + delta;
      if (to < 0 || to >= slugs.length) return;
      const moved = moveItem(slugs, from, to);
      const bySlug = new Map((this.server?.apps ?? []).map(a => [a.slug, a.id] as const));
      const ids = moved.flatMap(s => {
        const id = bySlug.get(s);
        return id ? [id] : [];
      });
      this.applyAppOrder(moved, ids);
      this.groupH2(slug)?.focus();
    } else {
      const next = slugs[(from + delta + slugs.length) % slugs.length]!;
      const h2 = this.groupH2(next);
      h2?.focus();
      this.querySelectorAll<HTMLElement>('.ws-group > h2').forEach(el => {
        el.tabIndex = el === h2 ? 0 : -1;
      });
    }
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

  /** One tab stop among the rows (per group) and, on the builder page, the
   *  group headers — the roving half of the keyboard reorder. */
  private applyRovingTabindex(): void {
    this.querySelectorAll('ul.ws-group-rows').forEach(ul => {
      const rows = [...ul.querySelectorAll<HTMLElement>('li[data-ws]')];
      const on = rows.find(li => li.dataset.ws === this.selected) ?? rows[0];
      rows.forEach(li => {
        li.tabIndex = li === on ? 0 : -1;
      });
    });
    if (this.view.scope !== 'builder') return;
    const heads = [...this.querySelectorAll<HTMLElement>('.ws-group > h2')];
    heads.forEach((h2, i) => {
      h2.tabIndex = i === 0 ? 0 : -1;
    });
  }
}

if (!customElements.get('workspace-sidebar'))
  customElements.define('workspace-sidebar', WorkspaceSidebar);
