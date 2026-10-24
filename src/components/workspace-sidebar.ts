// workspace-sidebar.ts — <workspace-sidebar>: the sidebar AS the app
// switcher (plan §8): workspaces grouped by app — the Console group
// (appId null) first, then each app by sort_order — workspace rows (name +
// live-terminal-count badge), a filter on workspace name, `+ workspace` in
// each group header, `+ app` at the bottom.
// Emits: select-workspace {id}, new-workspace {appId}, new-app,
// delete-workspace {id, name}, delete-app {slug, name} (all bubbling to
// <console-app>, which owns the dialogs and the API calls).
// The whole tree re-renders via innerHTML on the 15s state poll (the
// session-sidebar discipline): the filter input's value/focus/caret is
// captured before the swap and re-applied after, and no stateful wa-*
// component lives in here — the filter, badges and row buttons are
// stateless, re-created by the poll like every other row.
// Group collapse rides the same discipline: state lives OUTSIDE the DOM
// (localStorage, one key per app slug), is applied during render so a
// poll never flickers rows open, and the toggle is a real <button>
// flipping the DOM in place to what the next render would produce.
import type { AppServingState, ConsoleState, WorkspaceState } from '../lib/types';
import type { WorkspaceId } from '@cybermole/app-kit';
import { BASE } from '../base';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { esc } from './html';

/** <wa-input> surface used by this component (it's form-associated). */
interface WaInputLike extends HTMLElement {
  value: string;
  focus(options?: FocusOptions): void;
  setSelectionRange(start: number, end: number): void;
}

/** Caret offset inside a <wa-input>'s native input (null if unavailable). */
function caretOf(el: WaInputLike): number | null {
  const native =
    (el as unknown as { input?: HTMLInputElement }).input ??
    el.shadowRoot?.querySelector('input') ??
    null;
  return native ? native.selectionStart : null;
}

// ---- nav group collapse (task/collapsible-apps) ----

/** localStorage key holding a JSON object of collapsed groups —
 *  `{ "<slug>": true }` — so collapse survives reloads. Keyed by the
 *  app's stable slug; the Console group (appId null) gets the fixed key
 *  below. The in-memory set is the render-time source of truth (a poll
 *  re-render reads it, so collapsed groups never flicker open). */
const NAV_COLLAPSED_KEY = 'cybermole:nav-collapsed';
/** The Console group's fixed collapse key (apps use their slug). NB: an
 *  app named "Console" slugs to 'console' too — same collision its
 *  data-group already has on main; both groups then collapse in tandem. */
const CONSOLE_GROUP_KEY = 'console';

let collapsedGroups: Set<string> | null = null;

/** Collapsed group keys, read from localStorage once. A corrupt value
 *  reads as empty; a throwaway localStorage (private mode) just means no
 *  remembered collapses — collapsing still works for the session. */
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

/** Write a group's collapse through to the set + localStorage. */
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
    /* storage unavailable — the session still collapses */
  }
}

export class WorkspaceSidebar extends HTMLElement {
  private selected: WorkspaceId | null = null;
  private state: ConsoleState | null = null;
  private search = '';

  render(st: ConsoleState, selected: WorkspaceId | null): void {
    this.selected = selected;
    this.state = st;
    // Preserve in-progress typing + focus across the 15s poll re-render.
    const prevSearch = this.querySelector('#workspace-search') as WaInputLike | null;
    if (prevSearch) this.search = prevSearch.value;
    const searchFocused = prevSearch !== null && document.activeElement === prevSearch;
    const searchCaret = searchFocused && prevSearch ? caretOf(prevSearch) : null;
    this.innerHTML = `
      <nav class="nav">
        <wa-input id="workspace-search" class="workspace-search" placeholder="filter workspaces…" size="s">
          <wa-icon slot="start" name="magnifying-glass"></wa-icon>
        </wa-input>
        ${this.groups()}
        <wa-button id="new-app" class="new-app" appearance="plain" size="s" data-drawer="close">
          <wa-icon slot="start" name="plus"></wa-icon>new app
        </wa-button>
      </nav>`;
    const searchInput = this.querySelector('#workspace-search') as WaInputLike | null;
    if (searchInput) {
      searchInput.value = this.search;
      if (searchFocused) {
        // Restore focus/caret only after <wa-input>'s first render: its
        // .focus()/.setSelectionRange() forward to the native input inside
        // the shadow root, which Lit builds on a microtask.
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
    (this.querySelector('#new-app') as HTMLElement).onclick = () =>
      this.dispatchEvent(new CustomEvent('new-app', { bubbles: true, composed: true }));
    this.wireRows();
  }

  /** One console group (appId null) + one per app, in order. */
  private groups(): string {
    const st = this.state;
    if (!st) return '';
    const groups: string[] = [
      this.group(
        CONSOLE_GROUP_KEY,
        'console',
        st.workspaces.filter(w => w.appId === null),
      ),
    ];
    for (const app of st.apps) {
      groups.push(
        this.group(
          app.slug,
          app.name,
          st.workspaces.filter(w => w.appId === app.id),
          app,
        ),
      );
    }
    return groups.join('');
  }

  /** A group section: header (collapse chevron, name + `+ workspace` +
   *  app delete when an app) + its workspace rows (name, live-terminal
   *  count badge, delete). */
  private group(
    key: string,
    name: string,
    workspaces: WorkspaceState[],
    app?: AppServingState,
  ): string {
    const visible = workspaces.filter(w => this.matchesSearch(w));
    if (this.search.trim() && visible.length === 0) return ''; // a filter hides empty groups
    // Filter interaction: a non-empty filter forces groups open at render
    // (matches must be visible whatever is collapsed) and never writes the
    // stored state — clearing the filter restores each group's collapse.
    // The toggle itself always persists what it shows, so collapsing while
    // filtering sticks once the filter clears.
    const collapsed = this.search.trim() === '' && navCollapsed().has(key);
    const rowsId = `ws-group-rows-${key}`;
    const hide = collapsed ? ' hidden' : '';
    // task/app-web (apps-plan §4): the app group's open link — /apps/<slug>/
    // in a new tab (the editor tab's target=_blank pattern). A plain <a>
    // with an icon (no stateful wa-* — the poll discipline): serving=false
    // (a dead host, or a registered-but-unbuilt tree) only demotes it —
    // dimmed + the servingReason as its tooltip, still honest to click.
    const open = app
      ? `<a class="open-app-btn${app.serving ? '' : ' not-serving'}" ` +
        `href="${BASE}/apps/${esc(app.slug)}/" target="_blank" rel="noopener" ` +
        `title="${esc(app.serving ? `open ${app.name} in a new tab` : `${app.name} is not serving: ${app.servingReason ?? 'the app host is down'}`)}">` +
        `<wa-icon name="arrow-up-right-from-square" label="open ${esc(app.name)}"></wa-icon></a>`
      : '';
    const del = app
      ? `<wa-button class="del-app-btn" data-del-app="${esc(app.slug)}" size="xs" appearance="plain" ` +
        `title="delete the app ${esc(app.name)} (and its workspaces)">` +
        `<wa-icon name="trash-can" label="delete app"></wa-icon></wa-button>`
      : '';
    const rows = visible.length
      ? `<ul class="ws-group-rows" id="${rowsId}"${hide}>${visible.map(w => this.row(w)).join('')}</ul>`
      : `<p class="ws-group-rows group-empty" id="${rowsId}"${hide}>no workspaces yet</p>`;
    // HOOK(task/app-cwd × task/collapsible-apps, resolved at merge): the
    // app's cwd rides the header's title tooltip (the group's start dir is
    // discoverable without opening the dialog), on top of the collapse
    // chevron + actions.
    const title = app
      ? app.cwd
        ? `${app.name} — workspaces start at ${app.cwd}`
        : app.name
      : 'console';
    return (
      `<section class="ws-group" data-group="${esc(key)}">` +
      `<h2>` +
      `<button type="button" class="g-collapse" data-toggle-group="${esc(key)}" ` +
      `aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${rowsId}" ` +
      `aria-label="${esc(name)} workspaces">` +
      `<wa-icon name="chevron-down"></wa-icon></button>` +
      `<span class="g-name" title="${esc(title)}">${esc(name)}</span>` +
      `<span class="g-actions">` +
      open +
      `<wa-button class="new-ws-btn" data-new-ws="${app ? esc(app.id) : ''}" size="xs" appearance="plain" ` +
      `title="new workspace in ${esc(name)}"><wa-icon name="plus" label="new workspace"></wa-icon></wa-button>` +
      del +
      `</span></h2>${rows}</section>`
    );
  }

  private row(w: WorkspaceState): string {
    const cls = w.id === this.selected ? ' class="active"' : '';
    const live = w.terminals.filter(t => t.live).length;
    const badge =
      live > 0
        ? `<wa-badge pill variant="success" title="${live} live terminal${live === 1 ? '' : 's'}">${live}</wa-badge>`
        : '';
    return (
      `<li${cls} data-ws="${esc(w.id)}" data-drawer="close" title="${esc(w.cwd)}">` +
      `<span class="row-main">` +
      `<span class="t"><wa-icon name="folder"></wa-icon><span class="t-name">${esc(w.name)}</span></span>` +
      `<span class="d">${esc(w.cwd)}</span>` +
      `</span>` +
      `<span class="row-actions">` +
      (w.terminals.length
        ? `<span class="ws-count" title="${w.terminals.length} terminal tab${w.terminals.length === 1 ? '' : 's'}">${w.terminals.length}</span>`
        : '') +
      badge +
      `<wa-button class="del-ws-btn" data-del-ws="${esc(w.id)}" size="xs" appearance="plain" ` +
      `title="delete the workspace ${esc(w.name)} (and its terminals)">` +
      `<wa-icon name="trash-can" label="delete workspace"></wa-icon></wa-button>` +
      `</span></li>`
    );
  }

  /** The plan's locked filter shape (§1/§8): workspace NAME only — a cwd
   *  match would light up every workspace sharing a root (/tmp/…). */
  private matchesSearch(w: WorkspaceState): boolean {
    const q = this.search.trim().toLowerCase();
    return !q || w.name.toLowerCase().includes(q);
  }

  /** Re-render just the groups + rewire (keeps the search box's
   *  focus/caret untouched while typing — only the poll swaps the input). */
  private updateList(): void {
    const nav = this.querySelector('.nav');
    if (!nav) return;
    nav.querySelectorAll('.ws-group').forEach(g => g.remove());
    this.querySelector('#new-app')?.insertAdjacentHTML('beforebegin', this.groups());
    this.wireRows();
  }

  /** Row + group-header actions — everything the innerHTML re-renders
   *  (render() AND updateList(): a filter keystroke rebuilds the groups,
   *  whose headers carry the + workspace buttons). */
  private wireRows(): void {
    this.querySelectorAll<HTMLElement>('[data-toggle-group]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        const key = el.dataset.toggleGroup ?? '';
        const collapsed = !navCollapsed().has(key);
        setGroupCollapsed(key, collapsed);
        // Flip in place — the exact DOM the next poll render would emit —
        // so the toggle is instant and keeps focus on the button (no
        // re-render to lose it to). The chevron rotation follows
        // aria-expanded in CSS.
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
    });
    this.querySelectorAll<HTMLElement>('[data-del-ws]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation(); // the row itself selects; the button deletes
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
  }
}

if (!customElements.get('workspace-sidebar'))
  customElements.define('workspace-sidebar', WorkspaceSidebar);
