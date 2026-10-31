// <terminal-tabs>: the selected workspace's tab bar and panes. Each tab's
// <agent-terminal> is created on first activation and stays connected while
// hidden. The editor tab (an iframe of the /editor proxy) is pinned last.
// Bar updates are granular node moves and class flips, never innerHTML
// swaps, so listeners and focus survive.
//
// Tabs reorder by drag (the dragged tab follows the pointer across the
// bar's midpoints) or by Shift+Arrow on a focused tab. A reorder is
// optimistic: the bar moves at once, the order rides a
// 'reorder-terminals' event up to <console-app>, and the next sync
// confirms it (or, after a failed write, reverts the bar).
//
// Pop-out moves a terminal to its own browser tab (/view?t=<id>: the
// chrome-free single view). It's a move, not a copy: the server attaches
// with `tmux attach -d`, so two clients would bump each other. The pane's
// socket closes but the session survives; the terminal comes back when the
// popped tab closes or this tab is clicked.
//
// Emits (bubbling, handled by <console-app>): new-terminal {workspaceId,
// command}, close-terminal {id}, new-workspace {appId}, pop-blocked {id},
// reorder-terminals {workspaceId, order}.
import type { TerminalState, WorkspaceState } from '../../lib/platform/types';
import type { TerminalId, TmuxSessionName, WorkspaceId } from '@cybermole/app-kit';
import { BASE } from '../../base';
import { moveItem, type TerminalCommand } from '../../lib/terminals/tab-order';
import { armEditorThemeReload, editorSrc } from '../editor-pane';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import type { AgentTerminal } from '../AgentTerminal/agent-terminal';
import '../AgentTerminal/agent-terminal';

/** A terminal id is a uuid, so no collision. */
const EDITOR = 'editor';

/** After a popped tab's pagehide, wait this long before trusting `closed`. */
const POPUP_GONE_MS = 300;

type ActiveTab = TerminalId | typeof EDITOR | null;

export class TerminalTabs extends HTMLElement {
  private ws: WorkspaceState | null = null;
  private editorEnabled = false;
  private active: ActiveTab = null;
  private readonly tabs = new Map<TerminalId, HTMLButtonElement>();
  private readonly panes = new Map<TerminalId, AgentTerminal>();
  private bar: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  /** Popped tabs' window handles; pagehide or `closed` brings the terminal back. */
  private readonly popped = new Map<TerminalId, Window>();
  /** Only one tab can be both popped and active. */
  private poppedNotice: HTMLElement | null = null;
  private editorTab: HTMLButtonElement | null = null;
  private newTabGroup: HTMLElement | null = null;
  /** The editor pane: a toolbar (pop-out) above the workbench iframe. */
  private editorHost: HTMLElement | null = null;
  /** The in-flight optimistic tab order, until a poll confirms the write. */
  private pendingOrder: TerminalId[] | null = null;
  /** The tab being dragged, null when no drag is live. */
  private dragging: TerminalId | null = null;
  private runHost: HTMLElement | null = null;
  private runPane: AgentTerminal | null = null;
  /** A named field so re-adding the listener on reconnect dedupes. */
  private readonly onPanePopOut = (e: Event): void => {
    this.popTerminal((e as CustomEvent<{ id: TerminalId }>).detail.id);
  };

  connectedCallback(): void {
    this.addEventListener('terminal-pop-out', this.onPanePopOut);
    if (this.bar) return;
    this.innerHTML = `
      <div class="tabs-bar" role="tablist" aria-label="terminal tabs"></div>
      <div class="tabs-body"></div>`;
    this.bar = this.querySelector('.tabs-bar');
    this.body = this.querySelector('.tabs-body');
  }

  // ---- workspace lifecycle ----

  /** null shows the create prompt. Switching workspaces is the one place
   *  panes are discarded; tmux keeps the content. initialTab (the ?t= deep
   *  link) is activated instead of the first, so no pane attaches only to
   *  be hidden. */
  setWorkspace(ws: WorkspaceState | null, editorEnabled: boolean, initialTab?: TerminalId): void {
    this.ws = ws;
    this.editorEnabled = editorEnabled;
    this.pendingOrder = null; // any optimistic order belonged to the old workspace
    this.teardownPanes();
    if (!this.bar || !this.body) return;
    this.bar.innerHTML = '';
    if (!ws) {
      this.body.innerHTML = `
        <div class="tabs-empty tabs-empty-nows">
          <wa-icon name="folder"></wa-icon>
          <p>no workspace selected</p>
          <wa-button size="s" class="empty-new-workspace">
            <wa-icon slot="start" name="plus"></wa-icon>new workspace
          </wa-button>
        </div>`;
      (this.querySelector('.empty-new-workspace') as HTMLElement).onclick = () =>
        this.dispatchEvent(
          new CustomEvent('new-workspace', {
            detail: { appId: null },
            bubbles: true,
            composed: true,
          }),
        );
      return;
    }
    this.body.innerHTML = '';
    for (const [i, t] of ws.terminals.entries()) {
      this.addTabButton(t);
      this.updateTabButton(t, i);
    }
    this.appendEditorTab();
    this.appendNewTabButtons();
    this.body.appendChild(this.runPaneHost());
    const initial =
      initialTab !== undefined && ws.terminals.some(t => t.id === initialTab) ? initialTab : null;
    if (initial !== null) this.selectTerminal(initial);
    else if (!this.selectFirstTerminal()) this.renderNoTerminals();
  }

  /** Granular reconcile with a fresh poll: nodes are moved, never rebuilt. */
  sync(ws: WorkspaceState): void {
    if (!this.bar || this.ws?.id !== ws.id) return;
    // An in-flight optimistic reorder keeps the display order until a poll
    // confirms it (identical ids) — a mid-write poll must not snap the bar
    // back. Tabs that appeared or vanished elsewhere still reconcile.
    if (this.pendingOrder !== null) {
      const serverIds = ws.terminals.map(t => t.id);
      const confirmed =
        serverIds.length === this.pendingOrder.length &&
        serverIds.every((id, i) => id === this.pendingOrder![i]);
      if (confirmed) {
        this.pendingOrder = null;
      } else {
        const byId = new Map(ws.terminals.map(t => [t.id, t] as const));
        const ordered = this.pendingOrder
          .map(id => byId.get(id))
          .filter((t): t is TerminalState => t !== undefined);
        const seen = new Set(ordered.map(t => t.id));
        ws = {
          ...ws,
          terminals: [...ordered, ...ws.terminals.filter(t => !seen.has(t.id))],
        };
      }
    }
    this.ws = ws;
    // appendChild moves buttons into state order; editor and the new-tab
    // group stay last.
    for (const t of ws.terminals) {
      if (!this.tabs.has(t.id)) this.addTabButton(t);
      this.bar.appendChild(this.tabs.get(t.id)!);
    }
    if (this.editorTab) this.bar.appendChild(this.editorTab);
    if (this.newTabGroup) this.bar.appendChild(this.newTabGroup);
    const seen = new Set<TerminalId>();
    ws.terminals.forEach((t, i) => {
      seen.add(t.id);
      this.updateTabButton(t, i);
    });
    for (const [id, tab] of this.tabs) {
      if (seen.has(id)) continue;
      tab.remove();
      this.tabs.delete(id);
      this.unpop(id);
      this.destroyPane(id);
    }
    if (this.active !== null && this.active !== EDITOR && !seen.has(this.active)) {
      this.active = null;
      this.clearNoTerminals();
      this.clearPoppedNotice();
      if (!this.selectFirstTerminal()) this.renderNoTerminals();
    }
  }

  // ---- reorder ----

  /** The bar's ids in display order (an optimistic reorder mutates ws). */
  private displayIds(): TerminalId[] {
    return this.ws ? this.ws.terminals.map(t => t.id) : [];
  }

  /** Moves the bar to the state order and pins editor/new-tab last. */
  private applyDomOrder(): void {
    if (!this.bar || !this.ws) return;
    for (const t of this.ws.terminals) {
      const tab = this.tabs.get(t.id);
      if (tab) this.bar.appendChild(tab);
    }
    if (this.editorTab) this.bar.appendChild(this.editorTab);
    if (this.newTabGroup) this.bar.appendChild(this.newTabGroup);
  }

  /** Optimistic: ws and the bar take the order at once, and the write rides
   *  the event up to <console-app>, which reports back via reorderSettled. */
  private applyOrder(ids: TerminalId[]): void {
    if (!this.ws || !this.bar) return;
    const byId = new Map(this.ws.terminals.map(t => [t.id, t] as const));
    const reordered = ids
      .map(id => byId.get(id))
      .filter((t): t is TerminalState => t !== undefined);
    if (reordered.length !== this.ws.terminals.length) return; // vanished mid-drag: sync reconciles
    this.pendingOrder = ids;
    this.ws = { ...this.ws, terminals: reordered };
    this.applyDomOrder();
    reordered.forEach((t, i) => this.updateTabButton(t, i)); // "term N" labels renumber
    this.dispatchEvent(
      new CustomEvent('reorder-terminals', {
        detail: { workspaceId: this.ws!.id, order: ids },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** The console's reorder PUT settled. A failure clears the optimistic
   *  order (the sync the console fires right after reverts the bar); a
   *  success confirms only ITS order — a superseded one (a newer drag is
   *  still in flight) must not clear the newer pending order. */
  reorderSettled(ok: boolean, order?: TerminalId[]): void {
    if (!ok) {
      this.pendingOrder = null;
      return;
    }
    if (
      order !== undefined &&
      this.pendingOrder !== null &&
      order.length === this.pendingOrder.length &&
      order.every((id, i) => id === this.pendingOrder![i])
    )
      this.pendingOrder = null;
  }

  /** HTML5 drag: the dragged tab follows the pointer, hopping each tab's
   *  midpoint, so the drop position is already the DOM order. */
  private onTabDragStart(id: TerminalId, e: DragEvent): void {
    this.dragging = id;
    // Data is required for Firefox to start a drag at all.
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    this.tabs.get(id)?.classList.add('dragging');
  }

  private onTabDragOver(over: TerminalId, e: DragEvent): void {
    const dragged = this.dragging;
    if (dragged === null) return;
    // Every tab is a drop target, the dragged one too: dropping on itself
    // keeps the preview position (dragend alone would snap it back).
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (dragged === over) return;
    const draggedEl = this.tabs.get(dragged);
    const overEl = this.tabs.get(over);
    if (!this.bar || !draggedEl || !overEl) return;
    const rect = overEl.getBoundingClientRect();
    const reference = e.clientX > rect.left + rect.width / 2 ? overEl.nextSibling : overEl;
    if (draggedEl !== reference && draggedEl.nextSibling !== reference)
      this.bar.insertBefore(draggedEl, reference);
  }

  private onTabDrop(e: DragEvent): void {
    if (this.dragging === null) return;
    e.preventDefault();
    this.finishDrag();
  }

  private onTabDragEnd(id: TerminalId): void {
    if (this.dragging !== null) {
      // No drop: the preview moved the tab, so snap the bar back.
      this.dragging = null;
      this.applyDomOrder();
    }
    this.tabs.get(id)?.classList.remove('dragging');
  }

  private finishDrag(): void {
    const id = this.dragging;
    this.dragging = null;
    this.tabs.get(id!)?.classList.remove('dragging');
    if (id === null || !this.bar) return;
    const ids: TerminalId[] = [];
    for (const el of this.bar.children) {
      const term = (el as HTMLElement).dataset.term;
      if (term !== undefined && this.tabs.has(term as TerminalId)) ids.push(term as TerminalId);
    }
    this.applyOrder(ids);
  }

  /** Arrows walk the tab bar (roving focus, wrapping); Shift+Arrow moves
   *  the focused tab itself — the keyboard half of drag-reorder. */
  private onTabKeydown(id: TerminalId, e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const ids = this.displayIds();
    const from = ids.indexOf(id);
    if (from < 0) return;
    const delta = e.key === 'ArrowLeft' ? -1 : 1;
    if (e.shiftKey) {
      const to = from + delta;
      if (to < 0 || to >= ids.length) return;
      this.applyOrder(moveItem(ids, from, to));
      // A DOM move can drop focus; the tab stays where the user is looking.
      this.tabs.get(id)?.focus();
    } else {
      const next = ids[(from + delta + ids.length) % ids.length]!;
      this.setRovingTabindex(next);
      this.tabs.get(next)?.focus();
    }
  }

  /** One tab stop in the bar: the given terminal tab, the rest -1. */
  private setRovingTabindex(on: TerminalId | null): void {
    let any = false;
    for (const [id, tab] of this.tabs) {
      const isOn = id === on;
      if (isOn) any = true;
      tab.tabIndex = isOn ? 0 : -1;
    }
    if (!any) for (const tab of this.tabs.values()) tab.tabIndex = 0;
  }

  // ---- pop-out ----

  /** Closes the pane before the popped tab attaches (its `attach -d` would
   *  bump this one). destroyPane only closes the socket; the close-terminal
   *  path would kill the session. */
  popTerminal(id: TerminalId): void {
    if (!this.ws || !this.ws.terminals.some(t => t.id === id)) return;
    const existing = this.popped.get(id);
    if (existing) {
      if (!existing.closed) {
        existing.focus();
        return;
      }
      this.unpop(id); // its tab died without a pagehide
    }
    // Open before tearing down, so a blocked open leaves the pane intact.
    // '_blank' with no features string is a new tab, not a popup.
    const win = window.open(`${BASE}/view?t=${id}`, '_blank');
    if (!win) {
      this.dispatchEvent(
        new CustomEvent('pop-blocked', {
          detail: { id },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }
    this.popped.set(id, win);
    this.destroyPane(id);
    this.markPopped(id, true);
    this.showPoppedNotice();
    // Same-origin navigation reuses the window, so the about:blank → /view?t=
    // swap fires pagehide too. Only count it once `closed` is true.
    win.addEventListener('pagehide', () => {
      setTimeout(() => {
        if (win.closed) this.popupClosed(id, win);
      }, POPUP_GONE_MS);
    });
  }

  /** The active popped tab re-attaches here at once; an inactive one just drops its mark. */
  private popupClosed(id: TerminalId, win: Window): void {
    if (this.popped.get(id) !== win) return; // reclaimed or re-popped meanwhile
    this.unpop(id);
    if (this.active === id) this.selectTerminal(id);
  }

  private unpop(id: TerminalId): void {
    if (this.popped.delete(id)) this.markPopped(id, false);
  }

  /** Updates the aria label now rather than at the next poll. */
  private markPopped(id: TerminalId, on: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.classList.toggle('popped', on);
    const ws = this.ws;
    const i = ws ? ws.terminals.findIndex(t => t.id === id) : -1;
    if (i >= 0) this.updateTabButton(ws!.terminals[i]!, i);
  }

  /** The popped tab stays selected, so its spot says where the terminal went. */
  private showPoppedNotice(): void {
    this.clearPoppedNotice();
    if (!this.body) return;
    const notice = document.createElement('div');
    notice.className = 'tabs-empty tabs-popped';
    notice.innerHTML = `
      <wa-icon name="arrow-up-right-from-square"></wa-icon>
      <p>popped out to its own tab — click the tab to bring it back here</p>`;
    this.body.appendChild(notice);
    this.poppedNotice = notice;
  }

  private clearPoppedNotice(): void {
    this.poppedNotice?.remove();
    this.poppedNotice = null;
  }

  // ---- tab selection ----

  /** A pane whose attach ended (the session died) is re-created, so the
   *  click is a fresh attach and the server respawns the session. */
  selectTerminal(id: TerminalId): void {
    if (!this.body || !this.ws || !this.ws.terminals.some(t => t.id === id)) return;
    this.hideRun();
    this.clearNoTerminals();
    this.clearPoppedNotice();
    // Clicking a popped tab brings it back: this attach bumps the popped
    // tab's client once, and its 'exit' ends it, so no loop.
    if (this.popped.has(id)) this.unpop(id);
    this.active = id;
    const dead = this.panes.get(id);
    if (dead?.ended) this.destroyPane(id);
    const pane = this.ensurePane(id);
    for (const [pid, p] of this.panes) {
      (p as unknown as HTMLElement).classList.toggle('hidden', pid !== id);
    }
    this.editorHost?.classList.add('hidden');
    this.markActive();
    pane.activate();
  }

  selectEditor(): void {
    if (!this.editorEnabled || !this.body) return;
    this.hideRun();
    this.clearNoTerminals();
    this.clearPoppedNotice();
    this.active = EDITOR;
    this.ensureEditorPane();
    for (const p of this.panes.values()) (p as unknown as HTMLElement).classList.add('hidden');
    this.editorHost?.classList.remove('hidden');
    this.markActive();
  }

  /** ?run=<name>: a transient pane for a live job run, never a tab. Hiding
   *  it destroys the instance, since the run dies with its command anyway. */
  showRun(target: TmuxSessionName): void {
    if (!this.body) return;
    // Never show the run pane next to an empty-state prompt.
    this.clearNoTerminals();
    this.clearPoppedNotice();
    this.querySelector('.tabs-empty-nows')?.classList.add('hidden');
    if (!this.runPane) {
      const el = document.createElement('agent-terminal') as AgentTerminal & HTMLElement;
      el.innerHTML = '<div class="terminal-container"></div><div class="terminal-status"></div>';
      this.runPaneHost().appendChild(el);
      this.runPane = el;
    }
    this.runPaneHost().classList.remove('hidden');
    for (const p of this.panes.values()) (p as unknown as HTMLElement).classList.add('hidden');
    this.editorHost?.classList.add('hidden');
    this.active = null;
    this.markActive();
    this.runPane.attach('run', target, `run:${target}`);
    this.runPane.activate();
  }

  private hideRun(): void {
    if (this.runPane) this.runPane.destroy();
    this.runHost?.classList.add('hidden');
    // Restore the no-workspace prompt showRun hid.
    this.querySelector('.tabs-empty-nows')?.classList.remove('hidden');
  }

  activeTerminalId(): TerminalId | null {
    return this.active === null || this.active === EDITOR ? null : this.active;
  }

  activeWorkspaceId(): WorkspaceId | null {
    return this.ws?.id ?? null;
  }

  private tabLabel(t: TerminalState, index: number): string {
    return t.title ?? `term ${index + 1}`;
  }

  private addTabButton(t: TerminalState): void {
    if (!this.bar) return;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.term = t.id;
    tab.draggable = true;
    tab.setAttribute('aria-keyshortcuts', 'Shift+ArrowLeft Shift+ArrowRight');
    tab.innerHTML =
      `<span class="tab-label"></span>` +
      `<span class="tab-close" role="button" title="close this terminal"><wa-icon name="xmark" label="close terminal"></wa-icon></span>`;
    (tab.querySelector('.tab-label') as HTMLElement).textContent = t.title ?? '';
    tab.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('.tab-close')) {
        e.stopPropagation();
        this.dispatchEvent(
          new CustomEvent('close-terminal', {
            detail: { id: t.id },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      this.selectTerminal(t.id);
    });
    tab.addEventListener('dragstart', e => this.onTabDragStart(t.id, e));
    tab.addEventListener('dragover', e => this.onTabDragOver(t.id, e));
    tab.addEventListener('drop', e => this.onTabDrop(e));
    tab.addEventListener('dragend', () => this.onTabDragEnd(t.id));
    tab.addEventListener('keydown', e => this.onTabKeydown(t.id, e));
    this.tabs.set(t.id, tab);
    this.bar.appendChild(tab);
  }

  /** Only touches what changed (including index-shifted "term N" labels). */
  private updateTabButton(t: TerminalState, index: number): void {
    const tab = this.tabs.get(t.id);
    if (!tab) return;
    const dot = tab.querySelector('.tab-dot') as HTMLElement | null;
    if (dot) {
      dot.classList.toggle('live', t.live);
      dot.title = t.live ? 'live' : 'not live';
    }
    const label = this.tabLabel(t, index);
    const labelEl = tab.querySelector('.tab-label') as HTMLElement;
    if (labelEl.textContent !== label) labelEl.textContent = label;
    tab.setAttribute(
      'aria-label',
      `${label}${t.live ? ' (live)' : ''}${this.popped.has(t.id) ? ' (popped out)' : ''}`,
    );
  }

  private appendEditorTab(): void {
    if (!this.bar || !this.editorEnabled) return;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab editor-tab';
    tab.dataset.term = EDITOR;
    tab.setAttribute('role', 'tab');
    tab.title = 'open the workspace folder in the editor';
    tab.innerHTML = `<wa-icon name="code" aria-hidden="true"></wa-icon><span class="tab-label">editor</span>`;
    tab.addEventListener('click', () => this.selectEditor());
    this.bar.appendChild(tab);
    this.editorTab = tab;
  }

  /** The new-tab affordances, pinned last in the bar: + opens a shell tab
   *  (the common case, same as today), the caret opens the menu with both
   *  kinds and their shortcuts. */
  private appendNewTabButtons(): void {
    if (!this.bar || !this.ws) return;
    const group = document.createElement('div');
    group.className = 'tab-new-group';
    const shell = document.createElement('button');
    shell.type = 'button';
    shell.className = 'tab-new';
    shell.title = 'new shell tab';
    shell.setAttribute('aria-label', 'new shell tab');
    shell.innerHTML = `<wa-icon name="plus" aria-hidden="true"></wa-icon>`;
    shell.addEventListener('click', () => this.emitNewTerminal('shell'));
    const menu = document.createElement('wa-dropdown');
    menu.setAttribute('placement', 'bottom-end');
    menu.className = 'tab-new-menu';
    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'tab-new-caret';
    caret.title = 'new tab options';
    caret.setAttribute('aria-label', 'new tab options');
    caret.setAttribute('slot', 'trigger');
    caret.innerHTML = `<wa-icon name="chevron-down" aria-hidden="true"></wa-icon>`;
    menu.appendChild(caret);
    for (const item of [
      { value: 'shell', icon: 'terminal', label: 'new shell tab', hint: 'ctrl t' },
      { value: 'agent', icon: 'robot', label: 'new agent tab', hint: 'ctrl shift t' },
    ] as const) {
      const entry = document.createElement('wa-dropdown-item');
      entry.setAttribute('value', item.value);
      entry.innerHTML =
        `<wa-icon slot="icon" name="${item.icon}" aria-hidden="true"></wa-icon>` +
        `<span>${item.label}</span><span slot="details">${item.hint}</span>`;
      menu.appendChild(entry);
    }
    menu.addEventListener('wa-select', e => {
      const chosen = (e as CustomEvent<{ item?: Element }>).detail.item;
      const value = chosen?.getAttribute('value');
      if (value === 'agent' || value === 'shell') this.emitNewTerminal(value);
    });
    group.append(shell, menu);
    this.bar.appendChild(group);
    this.newTabGroup = group;
  }

  private emitNewTerminal(command: TerminalCommand): void {
    this.dispatchEvent(
      new CustomEvent('new-terminal', {
        detail: { workspaceId: this.ws?.id, command },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private ensurePane(id: TerminalId): AgentTerminal {
    const existing = this.panes.get(id);
    if (existing) return existing;
    const el = document.createElement('agent-terminal') as AgentTerminal & HTMLElement;
    el.innerHTML = '<div class="terminal-container"></div><div class="terminal-status"></div>';
    this.body!.appendChild(el);
    this.panes.set(id, el);
    el.attach('terminal', id, `terminal:${id}`);
    return el;
  }

  /** Created on first open: a hidden iframe would still boot the whole workbench. */
  private ensureEditorPane(): void {
    if (this.editorHost || !this.body || !this.ws) return;
    armEditorThemeReload();
    const host = document.createElement('div');
    host.className = 'editor-host hidden';
    const bar = document.createElement('div');
    bar.className = 'editor-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'editor actions');
    const pop = document.createElement('wa-button');
    pop.className = 'tb-pop-out';
    pop.setAttribute('appearance', 'plain');
    pop.setAttribute('variant', 'neutral');
    pop.setAttribute('size', 'xs');
    pop.title = "pop out — open this workspace's editor in its own browser tab";
    pop.innerHTML =
      '<wa-icon slot="start" name="arrow-up-right-from-square" aria-hidden="true"></wa-icon>pop out';
    pop.addEventListener('click', () => this.popEditor());
    bar.appendChild(pop);
    const frame = document.createElement('iframe');
    frame.className = 'editor-frame';
    frame.title = 'editor';
    frame.src = editorSrc(this.ws.cwd);
    host.append(bar, frame);
    this.body.appendChild(host);
    this.editorHost = host;
  }

  /** The editor pops out to /view?w=<id>: a copy, not a move — the editor
   *  upstream serves many clients, so the pane here stays live (unlike a
   *  terminal pop-out, which moves the single attach). */
  private popEditor(): void {
    const id = this.ws?.id;
    if (!id) return;
    const win = window.open(`${BASE}/view?w=${id}`, '_blank');
    if (!win) {
      this.dispatchEvent(
        new CustomEvent('pop-blocked', {
          detail: { id },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  /** A teardown, not a drop: no reconnect. */
  private destroyPane(id: TerminalId): void {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.destroy();
    (pane as unknown as HTMLElement).remove();
    this.panes.delete(id);
  }

  /** Popped tabs stay open; their old handles' pagehide is ignored. */
  private teardownPanes(): void {
    for (const id of [...this.panes.keys()]) this.destroyPane(id);
    this.tabs.clear();
    this.popped.clear();
    this.clearPoppedNotice();
    this.editorTab?.remove();
    this.editorTab = null;
    this.newTabGroup?.remove();
    this.newTabGroup = null;
    this.pendingOrder = null;
    this.dragging = null;
    this.editorHost?.remove();
    this.editorHost = null;
    this.active = null;
    if (this.runPane) {
      this.runPane.destroy();
      (this.runPane as unknown as HTMLElement).remove();
      this.runPane = null;
    }
    this.runHost?.remove();
    this.runHost = null;
  }

  private selectFirstTerminal(): boolean {
    const first = this.ws?.terminals[0];
    if (!first) return false;
    this.selectTerminal(first.id);
    return true;
  }

  private renderNoTerminals(): void {
    if (!this.body || this.querySelector('.tabs-empty-terminals')) return;
    const empty = document.createElement('div');
    empty.className = 'tabs-empty tabs-empty-terminals';
    empty.innerHTML = `
      <wa-icon name="terminal"></wa-icon>
      <p>no terminals in this workspace yet</p>
      <wa-button size="s" class="empty-new-terminal">
        <wa-icon slot="start" name="plus"></wa-icon>new terminal
      </wa-button>`;
    this.body.appendChild(empty);
    (empty.querySelector('.empty-new-terminal') as HTMLElement).onclick = () =>
      this.dispatchEvent(
        new CustomEvent('new-terminal', {
          detail: { workspaceId: this.ws?.id },
          bubbles: true,
          composed: true,
        }),
      );
  }

  private clearNoTerminals(): void {
    this.querySelector('.tabs-empty-terminals')?.remove();
  }

  private runPaneHost(): HTMLElement {
    if (!this.runHost) {
      this.runHost = document.createElement('div');
      this.runHost.className = 'run-host hidden';
      this.body!.appendChild(this.runHost);
    }
    return this.runHost;
  }

  private markActive(): void {
    for (const [id, tab] of this.tabs) {
      const on = this.active === id;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.setRovingTabindex(
      this.active !== null && this.active !== EDITOR
        ? this.active
        : (this.ws?.terminals[0]?.id ?? null),
    );
    this.editorTab?.classList.toggle('active', this.active === EDITOR);
    this.editorTab?.setAttribute('aria-selected', this.active === EDITOR ? 'true' : 'false');
  }
}

if (!customElements.get('terminal-tabs')) customElements.define('terminal-tabs', TerminalTabs);
