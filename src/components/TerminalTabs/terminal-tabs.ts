// <terminal-tabs>: the enhancer for TerminalTabs.astro — the selected
// workspace's tabs on a wa-tab-group. Every structure is authored in the
// .astro (the empty states, the run host, the new-tab split button, and
// the <template> skeletons cloned per terminal); this fills class hooks
// and never builds markup. Each tab's <agent-terminal> is stamped into its
// panel on first activation and stays connected while the panel is
// hidden. The editor tab (an iframe of the /editor proxy) is pinned after
// the terminals.
//
// The group owns the tablist semantics, the panels' visibility and arrow
// focus (manual activation). Selection stays here: a selection is an
// attach, and the run view and the empty states select no tab at all, so
// markActive() sets every tab's and panel's `active` itself and the group
// follows (its MutationObserver re-syncs on `active`). The group is hidden
// while it holds no tab — wa-tab-group can't initialise an empty tablist.
//
// Tabs reorder by drag (the dragged tab follows the pointer across the
// tabs' midpoints) or by Shift+Arrow on a focused tab. A reorder is
// optimistic: the strip moves at once, the order rides a
// 'reorder-terminals' event up to <console-app>, and the next sync
// confirms it (or, after a failed write, reverts the strip).
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
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import type { AgentTerminal } from '../AgentTerminal/agent-terminal';
import '../AgentTerminal/agent-terminal';

/** A terminal id is a uuid, so no collision. */
const EDITOR = 'editor';

/** After a popped tab's pagehide, wait this long before trusting `closed`. */
const POPUP_GONE_MS = 300;

type ActiveTab = TerminalId | typeof EDITOR | null;

/** The group's `active` while no tab is selected: a panel name no tab
 *  has. Left empty, its first-visibility init would select the first tab. */
const NO_TAB = '-';

/** What the body shows: a tab's panel, the job-run pane, or an empty state. */
type View = 'tab' | 'run' | 'no-terminals' | 'no-workspace';

type PaneElement = AgentTerminal & HTMLElement;

export class TerminalTabs extends HTMLElement {
  private ws: WorkspaceState | null = null;
  private editorEnabled = false;
  private active: ActiveTab = null;
  private readonly tabs = new Map<TerminalId, HTMLElement>();
  private readonly panels = new Map<TerminalId, HTMLElement>();
  /** Stamped anchors' tooltips (in .tab-tips), by anchor id. */
  private readonly tips = new Map<string, HTMLElement>();
  private readonly panes = new Map<TerminalId, PaneElement>();
  private group: HTMLElement | null = null;
  private newTabGroup: HTMLElement | null = null;
  /** Popped tabs' window handles; pagehide or `closed` brings the terminal back. */
  private readonly popped = new Map<TerminalId, Window>();
  private editorTab: HTMLElement | null = null;
  /** Stamped on first open: a hidden iframe would still boot the whole workbench. */
  private editorPanel: HTMLElement | null = null;
  /** The in-flight optimistic tab order, until a poll confirms the write. */
  private pendingOrder: TerminalId[] | null = null;
  /** The tab being dragged, null when no drag is live. */
  private dragging: TerminalId | null = null;
  private runPane: PaneElement | null = null;

  connectedCallback(): void {
    if (this.group) return; // listeners on the host survive a re-connect
    this.group = this.querySelector('wa-tab-group');
    this.newTabGroup = this.querySelector('.tab-new-group');
    this.addEventListener('terminal-pop-out', e => {
      this.popTerminal((e as CustomEvent<{ id: TerminalId }>).detail.id);
    });
    // Capture: the close button sits inside its tab, and the group's own
    // click handler (in its shadow root) would select the tab first.
    this.addEventListener('click', e => this.onCloseClick(e), true);
    this.addEventListener('click', e => this.onClick(e));
    // Capture: Shift+Arrow must reach the reorder before the group's arrow
    // handler walks focus.
    this.addEventListener('keydown', e => this.onReorderKey(e), true);
    this.addEventListener('keydown', e => this.onSelectKey(e));
    this.addEventListener('dragstart', e => this.onTabDragStart(e));
    this.addEventListener('dragover', e => this.onTabDragOver(e));
    this.addEventListener('drop', e => this.onTabDrop(e));
    this.addEventListener('dragend', () => this.onTabDragEnd());
    this.addEventListener('wa-select', e => {
      const value = (e as CustomEvent<{ item?: Element }>).detail.item?.getAttribute('value');
      if (value === 'agent' || value === 'shell') this.emitNewTerminal(value);
    });
  }

  // ---- stamping ----

  /** Clones a skeleton's single root element from TerminalTabs.astro. */
  private stamp<T extends HTMLElement>(name: string): T {
    const tpl = this.querySelector<HTMLTemplateElement>(`:scope > template[${name}]`)!;
    return document.importNode(tpl.content, true).firstElementChild as T;
  }

  /** Call once the anchor is in the document: the tooltip binds on connect. */
  private addTip(template: string, anchor: HTMLElement): void {
    this.dropTip(anchor.id);
    const tip = this.stamp<HTMLElement>(template);
    tip.setAttribute('for', anchor.id);
    this.querySelector(':scope > .tab-tips')?.append(tip);
    this.tips.set(anchor.id, tip);
  }

  private dropTip(anchorId: string): void {
    this.tips.get(anchorId)?.remove();
    this.tips.delete(anchorId);
  }

  private setView(view: View): void {
    this.setAttribute('view', view);
    for (const el of this.querySelectorAll<HTMLElement>(':scope > [data-view]'))
      el.classList.toggle('hidden', el.dataset.view !== view);
    this.group?.classList.toggle('hidden', this.tabs.size === 0 && !this.editorTab);
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
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
    if (!this.group) return;
    if (!ws) {
      this.setView('no-workspace');
      return;
    }
    for (const [i, t] of ws.terminals.entries()) {
      this.addTab(t);
      this.updateTab(t, i);
    }
    this.appendEditorTab();
    if (this.newTabGroup) this.group.appendChild(this.newTabGroup);
    const initial =
      initialTab !== undefined && ws.terminals.some(t => t.id === initialTab) ? initialTab : null;
    if (initial !== null) this.selectTerminal(initial);
    else if (!this.selectFirstTerminal()) this.showNoTerminals();
  }

  /** Granular reconcile with a fresh poll: nodes are moved, never rebuilt. */
  sync(ws: WorkspaceState): void {
    if (!this.group || this.ws?.id !== ws.id) return;
    // An in-flight optimistic reorder keeps the display order until a poll
    // confirms it (identical ids) — a mid-write poll must not snap the
    // strip back. Tabs that appeared or vanished elsewhere still reconcile.
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
    for (const t of ws.terminals) if (!this.tabs.has(t.id)) this.addTab(t);
    this.applyDomOrder();
    const seen = new Set<TerminalId>();
    ws.terminals.forEach((t, i) => {
      seen.add(t.id);
      this.updateTab(t, i);
    });
    for (const id of [...this.tabs.keys()]) {
      if (seen.has(id)) continue;
      this.unpop(id);
      this.destroyPane(id);
      this.tabs.get(id)!.remove();
      this.tabs.delete(id);
      this.panels.get(id)!.remove();
      this.panels.delete(id);
      this.dropTip(`tab-close-${id}`);
    }
    if (this.active !== null && this.active !== EDITOR && !seen.has(this.active)) {
      this.active = null;
      if (!this.selectFirstTerminal()) this.showNoTerminals();
    } else {
      // A tab appearing (or the last vanishing) flips the group's visibility.
      this.setView((this.getAttribute('view') as View | null) ?? 'tab');
    }
  }

  // ---- reorder ----

  /** The strip's ids in display order (an optimistic reorder mutates ws). */
  private displayIds(): TerminalId[] {
    return this.ws ? this.ws.terminals.map(t => t.id) : [];
  }

  /** Moves the tabs to the state order and pins editor/new-tab last. Only
   *  the nav-slotted children's relative order matters; panels interleave. */
  private applyDomOrder(): void {
    if (!this.group || !this.ws) return;
    for (const t of this.ws.terminals) {
      const tab = this.tabs.get(t.id);
      if (tab) this.group.appendChild(tab);
    }
    if (this.editorTab) this.group.appendChild(this.editorTab);
    if (this.newTabGroup) this.group.appendChild(this.newTabGroup);
  }

  /** Optimistic: ws and the strip take the order at once, and the write
   *  rides the event up to <console-app>, which reports back via
   *  reorderSettled. */
  private applyOrder(ids: TerminalId[]): void {
    if (!this.ws) return;
    const byId = new Map(this.ws.terminals.map(t => [t.id, t] as const));
    const reordered = ids
      .map(id => byId.get(id))
      .filter((t): t is TerminalState => t !== undefined);
    if (reordered.length !== this.ws.terminals.length) return; // vanished mid-drag: sync reconciles
    this.pendingOrder = ids;
    this.ws = { ...this.ws, terminals: reordered };
    this.applyDomOrder();
    reordered.forEach((t, i) => this.updateTab(t, i)); // "term N" labels renumber
    this.emit('reorder-terminals', { workspaceId: this.ws.id, order: ids });
  }

  /** The console's reorder PUT settled. A failure clears the optimistic
   *  order (the sync the console fires right after reverts the strip); a
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

  /** The terminal tab an event happened in (never the editor tab). */
  private terminalTabOf(e: Event): TerminalId | null {
    const tab = (e.target as Element | null)?.closest?.('wa-tab[data-term]');
    const id = (tab as HTMLElement | null)?.dataset.term as TerminalId | undefined;
    return id !== undefined && this.tabs.has(id) ? id : null;
  }

  /** HTML5 drag: the dragged tab follows the pointer, hopping each tab's
   *  midpoint, so the drop position is already the DOM order. */
  private onTabDragStart(e: DragEvent): void {
    const id = this.terminalTabOf(e);
    if (id === null) return;
    this.dragging = id;
    // Data is required for Firefox to start a drag at all.
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    this.tabs.get(id)!.classList.add('dragging');
  }

  private onTabDragOver(e: DragEvent): void {
    const dragged = this.dragging;
    const over = this.terminalTabOf(e);
    if (dragged === null || over === null) return;
    // Every tab is a drop target, the dragged one too: dropping on itself
    // keeps the preview position (dragend alone would snap it back).
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (dragged === over) return;
    const draggedEl = this.tabs.get(dragged);
    const overEl = this.tabs.get(over);
    if (!this.group || !draggedEl || !overEl) return;
    const rect = overEl.getBoundingClientRect();
    const reference = e.clientX > rect.left + rect.width / 2 ? overEl.nextSibling : overEl;
    if (draggedEl !== reference && draggedEl.nextSibling !== reference)
      this.group.insertBefore(draggedEl, reference);
  }

  private onTabDrop(e: DragEvent): void {
    if (this.dragging === null) return;
    e.preventDefault();
    const id = this.dragging;
    this.dragging = null;
    this.tabs.get(id)?.classList.remove('dragging');
    if (!this.group) return;
    const ids: TerminalId[] = [];
    for (const el of this.group.children) {
      const term = (el as HTMLElement).dataset.term as TerminalId | undefined;
      if (term !== undefined && this.tabs.has(term)) ids.push(term);
    }
    this.applyOrder(ids);
  }

  private onTabDragEnd(): void {
    if (this.dragging !== null) {
      // No drop: the preview moved the tab, so snap the strip back.
      this.tabs.get(this.dragging)?.classList.remove('dragging');
      this.dragging = null;
      this.applyDomOrder();
    }
  }

  /** Shift+Arrow moves the focused tab — the keyboard half of
   *  drag-reorder. Plain arrows are the group's (roving focus). */
  private onReorderKey(e: KeyboardEvent): void {
    if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const id = this.terminalTabOf(e);
    if (id === null) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = this.displayIds();
    const from = ids.indexOf(id);
    const to = from + (e.key === 'ArrowLeft' ? -1 : 1);
    if (from < 0 || to < 0 || to >= ids.length) return;
    this.applyOrder(moveItem(ids, from, to));
    // A DOM move can drop focus; the tab stays where the user is looking.
    this.tabs.get(id)?.focus();
  }

  // ---- clicks and keys ----

  private onCloseClick(e: MouseEvent): void {
    if (!(e.target as Element).closest('.tab-close')) return;
    const id = this.terminalTabOf(e);
    if (id === null) return;
    e.stopPropagation();
    this.emit('close-terminal', { id });
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as Element;
    if (target.closest('.tab-new')) this.emitNewTerminal('shell');
    else if (target.closest('.empty-new-terminal'))
      this.emit('new-terminal', { workspaceId: this.ws?.id });
    else if (target.closest('.empty-new-workspace')) this.emit('new-workspace', { appId: null });
    else if (target.closest('.editor-host .tb-pop-out')) this.popEditor();
    else this.selectTabOf(target);
  }

  /** Enter/Space on a focused tab (the group's manual activation). */
  private onSelectKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') this.selectTabOf(e.target as Element);
  }

  /** Clicking the already-active tab still selects: it re-attaches a
   *  popped or ended pane. */
  private selectTabOf(target: Element): void {
    const tab = target.closest<HTMLElement>('wa-tab[data-term]');
    if (!tab || tab.closest('terminal-tabs') !== this) return;
    if (tab.dataset.term === EDITOR) this.selectEditor();
    else this.selectTerminal(tab.dataset.term as TerminalId);
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
      this.emit('pop-blocked', { id });
      return;
    }
    this.popped.set(id, win);
    this.destroyPane(id);
    this.markPopped(id, true);
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

  /** The class, aria label and the panel's notice (it says where the
   *  terminal went) flip now rather than at the next poll. */
  private markPopped(id: TerminalId, on: boolean): void {
    const tab = this.tabs.get(id);
    const panel = this.panels.get(id);
    if (!tab || !panel) return;
    tab.classList.toggle('popped', on);
    panel.querySelector(':scope > .tabs-popped')?.remove();
    if (on) panel.appendChild(this.stamp('data-popped'));
    const ws = this.ws;
    const i = ws ? ws.terminals.findIndex(t => t.id === id) : -1;
    if (i >= 0) this.updateTab(ws!.terminals[i]!, i);
  }

  // ---- tab selection ----

  /** A pane whose attach ended (the session died) is re-created, so the
   *  click is a fresh attach and the server respawns the session. */
  selectTerminal(id: TerminalId): void {
    if (!this.ws || !this.ws.terminals.some(t => t.id === id)) return;
    this.hideRun();
    // Clicking a popped tab brings it back: this attach bumps the popped
    // tab's client once, and its 'exit' ends it, so no loop.
    if (this.popped.has(id)) this.unpop(id);
    this.active = id;
    this.markActive();
    this.setView('tab');
    if (this.panes.get(id)?.ended) this.destroyPane(id);
    const pane = this.ensurePane(id);
    // A freshly stamped panel renders its slot a microtask after connect;
    // until then the pane is outside the flat tree and can't fit or focus.
    void (
      this.panels.get(id) as HTMLElement & { updateComplete: Promise<unknown> }
    ).updateComplete.then(() => {
      if (this.active === id && this.panes.get(id) === pane) pane.activate();
    });
  }

  selectEditor(): void {
    if (!this.editorEnabled || !this.editorTab) return;
    this.hideRun();
    this.active = EDITOR;
    this.ensureEditorPanel();
    this.markActive();
    this.setView('tab');
  }

  /** ?run=<name>: a transient pane for a live job run, never a tab. Hiding
   *  it destroys the instance, since the run dies with its command anyway. */
  showRun(target: TmuxSessionName): void {
    const host = this.querySelector<HTMLElement>(':scope > [data-view="run"]');
    if (!host) return;
    if (!this.runPane) {
      this.runPane = this.stamp<PaneElement>('data-pane');
      host.appendChild(this.runPane);
    }
    this.active = null;
    this.markActive();
    this.setView('run');
    this.runPane.attach('run', target, `run:${target}`);
    this.runPane.activate();
  }

  private hideRun(): void {
    this.runPane?.destroy();
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

  /** A tab and its (empty) panel; the pane is stamped on first select. */
  private addTab(t: TerminalState): void {
    if (!this.group) return;
    const tab = this.stamp<HTMLElement>('data-tab');
    tab.dataset.term = t.id;
    tab.setAttribute('panel', t.id);
    const panel = this.stamp<HTMLElement>('data-panel');
    panel.setAttribute('name', t.id);
    const close = tab.querySelector<HTMLElement>('.tab-close')!;
    close.id = `tab-close-${t.id}`;
    this.tabs.set(t.id, tab);
    this.panels.set(t.id, panel);
    this.group.append(tab, panel);
    this.addTip('data-close-tip', close);
  }

  /** Only touches what changed (including index-shifted "term N" labels). */
  private updateTab(t: TerminalState, index: number): void {
    const tab = this.tabs.get(t.id);
    if (!tab) return;
    const label = this.tabLabel(t, index);
    const labelEl = tab.querySelector('.tab-label')!;
    if (labelEl.textContent !== label) labelEl.textContent = label;
    tab.setAttribute(
      'aria-label',
      `${label}${t.live ? ' (live)' : ''}${this.popped.has(t.id) ? ' (popped out)' : ''}`,
    );
  }

  private appendEditorTab(): void {
    if (!this.group || !this.editorEnabled) return;
    this.editorTab = this.stamp<HTMLElement>('data-editor-tab');
    this.group.appendChild(this.editorTab);
    this.addTip('data-editor-tab-tip', this.editorTab);
  }

  private emitNewTerminal(command: TerminalCommand): void {
    this.emit('new-terminal', { workspaceId: this.ws?.id, command });
  }

  private ensurePane(id: TerminalId): AgentTerminal {
    const existing = this.panes.get(id);
    if (existing) return existing;
    const pane = this.stamp<PaneElement>('data-pane');
    this.panels.get(id)!.appendChild(pane);
    this.panes.set(id, pane);
    pane.attach('terminal', id, `terminal:${id}`);
    return pane;
  }

  private ensureEditorPanel(): void {
    if (this.editorPanel || !this.group || !this.ws) return;
    armEditorThemeReload();
    const panel = this.stamp<HTMLElement>('data-editor-panel');
    panel.querySelector<HTMLIFrameElement>('.editor-frame')!.src = editorSrc(this.ws.cwd);
    this.group.appendChild(panel);
    this.editorPanel = panel;
    this.addTip('data-editor-pop-tip', panel.querySelector<HTMLElement>('.tb-pop-out')!);
  }

  /** The editor pops out to /view?w=<id>: a copy, not a move — the editor
   *  upstream serves many clients, so the pane here stays live (unlike a
   *  terminal pop-out, which moves the single attach). */
  private popEditor(): void {
    const id = this.ws?.id;
    if (!id) return;
    const win = window.open(`${BASE}/view?w=${id}`, '_blank');
    if (!win) this.emit('pop-blocked', { id });
  }

  /** A teardown, not a drop: no reconnect. */
  private destroyPane(id: TerminalId): void {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.destroy();
    pane.remove();
    this.panes.delete(id);
  }

  /** Popped tabs stay open; their old handles' pagehide is ignored. */
  private teardownPanes(): void {
    for (const id of [...this.panes.keys()]) this.destroyPane(id);
    for (const el of [...this.tabs.values(), ...this.panels.values(), ...this.tips.values()])
      el.remove();
    this.tabs.clear();
    this.panels.clear();
    this.tips.clear();
    this.popped.clear();
    this.editorTab?.remove();
    this.editorTab = null;
    this.editorPanel?.remove();
    this.editorPanel = null;
    this.pendingOrder = null;
    this.dragging = null;
    this.active = null;
    if (this.runPane) {
      this.runPane.destroy();
      this.runPane.remove();
      this.runPane = null;
    }
  }

  private selectFirstTerminal(): boolean {
    const first = this.ws?.terminals[0];
    if (!first) return false;
    this.selectTerminal(first.id);
    return true;
  }

  private showNoTerminals(): void {
    this.active = null;
    this.markActive();
    this.setView('no-terminals');
  }

  /** One tab stop in the strip: the active terminal's tab, else the first. */
  private markActive(): void {
    // The attribute, not the property: the panel's display follows it now,
    // not at the element's next Lit update, so a pane activates visible.
    for (const [id, tab] of this.tabs) tab.toggleAttribute('active', id === this.active);
    for (const [id, panel] of this.panels) panel.toggleAttribute('active', id === this.active);
    this.editorTab?.toggleAttribute('active', this.active === EDITOR);
    this.editorPanel?.toggleAttribute('active', this.active === EDITOR);
    this.group?.setAttribute('active', this.active ?? NO_TAB);
    const stop =
      this.active !== null && this.active !== EDITOR
        ? this.active
        : (this.ws?.terminals[0]?.id ?? null);
    for (const [id, tab] of this.tabs) tab.tabIndex = id === stop ? 0 : -1;
  }
}

if (!customElements.get('terminal-tabs')) customElements.define('terminal-tabs', TerminalTabs);
