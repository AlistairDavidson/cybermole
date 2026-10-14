// terminal-tabs.ts — <terminal-tabs>: the selected workspace's tab bar and
// panes (plan §8). Light DOM (xterm injects its own styles; the bar is
// plain buttons + wa-icon, upgraded when this module defines them).
//
// One <agent-terminal> per terminal tab, created on the tab's FIRST
// activation: a never-activated tab holds no xterm/WS/WebGL at all, an
// activated-then-hidden tab KEEPS its instance connected (state and
// scrollback persist, matching how tmux detach works) and activate()
// restores it on re-show. The editor tab is pinned last — an iframe of
// the same-origin /editor proxy with the workspace cwd as the ?folder=
// param (spike-pinned URI-encoded), created only when the editor tab is
// opened — and rendered only when the editor is configured. Tab-bar
// updates are granular (per-tab dot flips and label edits), never
// innerHTML swaps of the bar (the AGENTS.md sidebar caveat): sync()
// moves/adds/removes button nodes and touches classes.
//
// Emits: new-terminal {workspaceId}, close-terminal {id},
// new-workspace {appId} (the no-workspace empty state's prompt). All
// bubble to <console-app>, which owns the dialogs and the API calls.
import type { TerminalState, WorkspaceState } from '../../lib/types';
import type { TerminalId, TmuxSessionName, WorkspaceId } from '../../types/branded';
import { BASE } from '../../base';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import type { AgentTerminal } from '../AgentTerminal/agent-terminal';
import '../AgentTerminal/agent-terminal';

/** The editor tab's pseudo-id (a terminal id is a uuid — no collision). */
const EDITOR = 'editor';

type ActiveTab = TerminalId | typeof EDITOR | null;

export class TerminalTabs extends HTMLElement {
  private ws: WorkspaceState | null = null;
  private editorEnabled = false;
  private active: ActiveTab = null;
  private readonly tabs = new Map<TerminalId, HTMLButtonElement>();
  private readonly panes = new Map<TerminalId, AgentTerminal>();
  private bar: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private editorTab: HTMLButtonElement | null = null;
  private plusButton: HTMLButtonElement | null = null;
  private editorPane: HTMLIFrameElement | null = null;
  private runHost: HTMLElement | null = null;
  private runPane: AgentTerminal | null = null;

  connectedCallback(): void {
    if (this.bar) return; // already built
    this.innerHTML = `
      <div class="tabs-bar" role="tablist" aria-label="terminal tabs"></div>
      <div class="tabs-body"></div>`;
    this.bar = this.querySelector('.tabs-bar');
    this.body = this.querySelector('.tabs-body');
  }

  // ---- workspace lifecycle ----

  /** Show a workspace (null = none selected: the create prompt). Tears
   *  down the previous workspace's panes — switching workspaces is the
   *  one place instances are discarded (within a workspace they persist);
   *  tmux keeps the content, a re-visit re-attaches and redraws.
   *  initialTab: the tab to activate instead of the first (the ?t= deep
   *  link) — avoids attaching a pane the deep link immediately hides. */
  setWorkspace(ws: WorkspaceState | null, editorEnabled: boolean, initialTab?: TerminalId): void {
    this.ws = ws;
    this.editorEnabled = editorEnabled;
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
        this.dispatchEvent(new CustomEvent('new-workspace', { detail: { appId: null }, bubbles: true, composed: true }));
      return;
    }
    this.body.innerHTML = '';
    // addTabButton + updateTabButton: the bar renders with the state's
    // dots/labels immediately — live flags are in hand, no poll needed.
    for (const [i, t] of ws.terminals.entries()) {
      this.addTabButton(t);
      this.updateTabButton(t, i);
    }
    this.appendEditorTab();
    this.appendPlusButton();
    this.body.appendChild(this.runPaneHost());
    const initial = initialTab !== undefined && ws.terminals.some(t => t.id === initialTab)
      ? initialTab : null;
    if (initial !== null) this.selectTerminal(initial);
    else if (!this.selectFirstTerminal()) this.renderNoTerminals();
  }

  /** Reconcile with a fresh state poll: add new tabs (in order), drop
   *  closed ones (destroying their panes), flip dots and edit labels —
   *  granular, per-tab; the bar's nodes are moved into order, never
   *  rebuilt, so listeners and focus survive. */
  sync(ws: WorkspaceState): void {
    if (!this.bar || this.ws?.id !== ws.id) return;
    this.ws = ws;
    // order first: appendChild MOVES existing buttons into state order,
    // then the editor tab and + button are re-pinned last.
    for (const t of ws.terminals) {
      if (!this.tabs.has(t.id)) this.addTabButton(t);
      this.bar.appendChild(this.tabs.get(t.id)!);
    }
    if (this.editorTab) this.bar.appendChild(this.editorTab);
    if (this.plusButton) this.bar.appendChild(this.plusButton);
    // granular updates + removals
    const seen = new Set<TerminalId>();
    ws.terminals.forEach((t, i) => {
      seen.add(t.id);
      this.updateTabButton(t, i);
    });
    for (const [id, tab] of this.tabs) {
      if (seen.has(id)) continue;
      tab.remove();
      this.tabs.delete(id);
      this.destroyPane(id);
    }
    if (this.active !== null && this.active !== EDITOR && !seen.has(this.active)) {
      this.active = null;
      this.clearNoTerminals();
      if (!this.selectFirstTerminal()) this.renderNoTerminals();
    }
  }

  // ---- tab selection ----

  /** Activate a terminal tab: creates the pane (and its WS attach) on
   *  first activation, shows it, hides every other pane. A pane whose
   *  attach ENDED (the session died out-of-band — plan §4's dead tab) is
   *  destroyed and re-created, so the click is a fresh attach and the
   *  server respawns the session at the workspace cwd. */
  selectTerminal(id: TerminalId): void {
    if (!this.body || !this.ws || !this.ws.terminals.some(t => t.id === id)) return;
    this.hideRun();
    this.clearNoTerminals();
    this.active = id;
    const dead = this.panes.get(id);
    if (dead?.ended) this.destroyPane(id);
    const pane = this.ensurePane(id);
    for (const [pid, p] of this.panes) {
      (p as unknown as HTMLElement).classList.toggle('hidden', pid !== id);
    }
    this.editorPane?.classList.add('hidden');
    this.markActive();
    pane.activate();
  }

  selectEditor(): void {
    if (!this.editorEnabled || !this.body) return;
    this.hideRun();
    this.clearNoTerminals();
    this.active = EDITOR;
    this.ensureEditorPane();
    for (const p of this.panes.values()) (p as unknown as HTMLElement).classList.add('hidden');
    this.editorPane?.classList.remove('hidden');
    this.markActive();
  }

  /** The ?run=<name> deep link (a live job run — the jobs page's "view"):
   *  a transient pane above the workspace's tabs, never a tab (a run is
   *  not a workspace terminal). Clicking any tab (or the editor) hides
   *  it — hideRun() destroys its instance (socket closed, reconnect
   *  cancelled), so the next run shows a FRESH attach; there is nothing
   *  to preserve: the run is the session, and it dies with the command. */
  showRun(target: TmuxSessionName): void {
    if (!this.body) return;
    // like selectTerminal/selectEditor: never show the run pane next to
    // an empty-state prompt (a workspace with no terminals, or none at all)
    this.clearNoTerminals();
    this.querySelector('.tabs-empty-nows')?.classList.add('hidden');
    if (!this.runPane) {
      const el = document.createElement('agent-terminal') as AgentTerminal & HTMLElement;
      el.innerHTML = '<div class="terminal-container"></div><div class="terminal-status"></div>';
      this.runPaneHost().appendChild(el);
      this.runPane = el;
    }
    this.runPaneHost().classList.remove('hidden');
    for (const p of this.panes.values()) (p as unknown as HTMLElement).classList.add('hidden');
    this.editorPane?.classList.add('hidden');
    this.active = null;
    this.markActive();
    this.runPane.attach('run', target, `run:${target}`);
    this.runPane.activate();
  }

  private hideRun(): void {
    if (this.runPane) this.runPane.destroy();
    this.runHost?.classList.add('hidden');
    // restore the no-workspace prompt a showRun hid (a workspace switch
    // rebuilds it anyway — this covers the tab-click path)
    this.querySelector('.tabs-empty-nows')?.classList.remove('hidden');
  }

  activeTerminalId(): TerminalId | null {
    return this.active === null || this.active === EDITOR ? null : this.active;
  }

  /** The workspace this element is currently showing (the poll's sync()
   *  guard — also how <console-app> tells a selection change from a
   *  refresh). */
  activeWorkspaceId(): WorkspaceId | null {
    return this.ws?.id ?? null;
  }

  // ---- internals ----

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
    tab.innerHTML =
      `<span class="tab-dot" aria-hidden="true"></span>` +
      `<span class="tab-label"></span>` +
      `<span class="tab-close" role="button" title="close this terminal"><wa-icon name="xmark" label="close terminal"></wa-icon></span>`;
    (tab.querySelector('.tab-label') as HTMLElement).textContent = t.title ?? '';
    tab.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('.tab-close')) {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent('close-terminal', {
          detail: { id: t.id }, bubbles: true, composed: true,
        }));
        return;
      }
      this.selectTerminal(t.id);
    });
    this.tabs.set(t.id, tab);
    this.bar.appendChild(tab);
  }

  /** The granular half of sync(): dot + label, only where they changed
   *  (index-shifted "term N" labels included). */
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
    tab.setAttribute('aria-label', `${label}${t.live ? ' (live)' : ''}`);
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

  private appendPlusButton(): void {
    if (!this.bar || !this.ws) return;
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'tab-new';
    plus.title = 'new terminal tab';
    plus.setAttribute('aria-label', 'new terminal tab');
    plus.innerHTML = `<wa-icon name="plus" aria-hidden="true"></wa-icon>`;
    plus.addEventListener('click', () => this.dispatchEvent(new CustomEvent('new-terminal', {
      detail: { workspaceId: this.ws?.id }, bubbles: true, composed: true,
    })));
    this.bar.appendChild(plus);
    this.plusButton = plus;
  }

  /** The selected tab's <agent-terminal>, attached (first activation:
   *  the pane AND its WS come into existence together — a never-visited
   *  tab holds neither). */
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

  /** The editor iframe pane — created on first open of the editor tab (a
   *  hidden iframe would still boot the whole workbench), src pinned by
   *  the spike's ?folder= shape (URI-encoded). */
  private ensureEditorPane(): void {
    if (this.editorPane || !this.body || !this.ws) return;
    const frame = document.createElement('iframe');
    frame.className = 'editor-frame hidden';
    frame.title = 'editor';
    frame.src = `${BASE}/editor/?folder=${encodeURIComponent(this.ws.cwd)}`;
    this.body.appendChild(frame);
    this.editorPane = frame;
  }

  /** End one pane's life: socket closed (no reconnect — this is a
   *  teardown, not a drop), element removed. */
  private destroyPane(id: TerminalId): void {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.destroy();
    (pane as unknown as HTMLElement).remove();
    this.panes.delete(id);
  }

  /** Everything pane-shaped goes: terminal panes, the editor iframe, the
   *  run pane, the bar's buttons. The bar/body shells stay. */
  private teardownPanes(): void {
    for (const id of [...this.panes.keys()]) this.destroyPane(id);
    this.tabs.clear();
    this.editorTab?.remove();
    this.editorTab = null;
    this.plusButton?.remove();
    this.plusButton = null;
    this.editorPane?.remove();
    this.editorPane = null;
    this.active = null;
    if (this.runPane) {
      this.runPane.destroy();
      (this.runPane as unknown as HTMLElement).remove();
      this.runPane = null;
    }
    this.runHost?.remove();
    this.runHost = null;
  }

  /** Select the workspace's first terminal tab (returns false when there
   *  is none). Used on workspace switch and when the active tab closed. */
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
      this.dispatchEvent(new CustomEvent('new-terminal', {
        detail: { workspaceId: this.ws?.id }, bubbles: true, composed: true,
      }));
  }

  private clearNoTerminals(): void {
    this.querySelector('.tabs-empty-terminals')?.remove();
  }

  /** The run pane's host (hidden until a run is shown). */
  private runPaneHost(): HTMLElement {
    if (!this.runHost) {
      this.runHost = document.createElement('div');
      this.runHost.className = 'run-host hidden';
      this.body!.appendChild(this.runHost);
    }
    return this.runHost;
  }

  /** Active styling on the bar — class flips, no rebuilds. */
  private markActive(): void {
    for (const [id, tab] of this.tabs) {
      const on = this.active === id;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    this.editorTab?.classList.toggle('active', this.active === EDITOR);
    this.editorTab?.setAttribute('aria-selected', this.active === EDITOR ? 'true' : 'false');
  }
}

if (!customElements.get('terminal-tabs')) customElements.define('terminal-tabs', TerminalTabs);
