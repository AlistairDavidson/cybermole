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
// Pop-out (the pane toolbar's pop-out button, task/popout-toolbar): a
// tab pops to its own browser TAB at /?t=<id> — a MOVE, not a copy: the
// server's attach runs `tmux attach -d`, which detaches any other
// client, so a popped tab and an in-page pane would fight over the
// session. Popping tears the pane down here (socket closed; the SESSION
// survives — unlike close-terminal, which kills it), keeps the row
// (marked popped, a notice in the body), and the terminal comes back on
// the popped tab's pagehide (this page holds the window handle — same
// origin; window.open returns one for a tab too) or on the tab's next
// activation (a fresh attach bumps the popped tab, once, no loop). The
// button lives in the ACTIVE pane's toolbar (agent-terminal.ts's
// ensureToolbar), so its click arrives here as a bubbled
// 'terminal-pop-out' {id} — the panes are this element's descendants.
//
// Emits: new-terminal {workspaceId}, close-terminal {id},
// new-workspace {appId} (the no-workspace empty state's prompt),
// pop-blocked {id} (a pop-out the browser refused — the pane never
// moved; <console-app> explains). All bubble to <console-app>, which
// owns the dialogs and the API calls.
import type { TerminalState, WorkspaceState } from '../../lib/platform/types';
import type { TerminalId, TmuxSessionName, WorkspaceId } from '@cybermole/app-kit';
import { BASE } from '../../base';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import type { AgentTerminal } from '../AgentTerminal/agent-terminal';
import '../AgentTerminal/agent-terminal';

/** The editor tab's pseudo-id (a terminal id is a uuid — no collision). */
const EDITOR = 'editor';

/** The editor pane's src: the same-origin /editor proxy with the
 *  workspace cwd as the ?folder= param (spike-pinned, URI-encoded). No
 *  theme param — VERIFIED against the vendored reh-web build (1.140.x,
 *  docs/guides/editor-webapp.md): the workbench client parses only folder/
 *  workspace/ew from the URL, so a theme param would be ignored. The
 *  workbench instead follows the BROWSER's scheme at boot (the proxy
 *  injects window.autoDetectColorScheme — src/lib/terminals/editor.ts), which is
 *  why a mode flip RELOADS the iframe (see the observer below): a reload
 *  re-reads the scheme at boot and lands the pane in the new mode. */
const editorSrc = (cwd: string): string => `${BASE}/editor/?folder=${encodeURIComponent(cwd)}`;

// One page-wide observer (the agent-terminal shared-wake pattern): when
// Base.astro's blocking script flips html's wa-dark/wa-light classes, an
// existing editor pane re-navigates. Re-assigning src (even the same
// value) is a reload per the iframe spec — the workbench re-boots in the
// now-current mode. The injected autoDetectColorScheme default
// (src/lib/terminals/editor.ts) sometimes re-themes a booted workbench live too,
// but not reliably (it rides a theme-file fetch); the reload is the
// deterministic path and is task-sanctioned — the two converge on the
// same theme either way. Workspace state is server-side; nothing is
// lost but the pane's scroll position.
let editorThemeArmed = false;
function armEditorThemeReload(): void {
  if (editorThemeArmed) return;
  editorThemeArmed = true;
  new MutationObserver(() => {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe.editor-frame'))
      frame.src = frame.src; // eslint-disable-line no-self-assign -- a reload, on purpose
  }).observe(document.documentElement, { attributeFilter: ['class'], attributes: true });
}

/** After a popped window's pagehide, how long before `closed` is trusted
 * (the close settles just after the event; a navigation does not). */
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
  /** Popped tabs — the live window handle of each (window.open returns
   *  one for a tab too; its pagehide brings the terminal back, `closed`
   *  catches a tab that died without one). */
  private readonly popped = new Map<TerminalId, Window>();
  /** The active popped tab's body notice (only one tab can be popped AND
   *  active; clicking any other tab clears it). */
  private poppedNotice: HTMLElement | null = null;
  private editorTab: HTMLButtonElement | null = null;
  private plusButton: HTMLButtonElement | null = null;
  private editorPane: HTMLIFrameElement | null = null;
  private runHost: HTMLElement | null = null;
  private runPane: AgentTerminal | null = null;
  /** The panes' toolbar pop-out buttons arrive as bubbled
   *  'terminal-pop-out' {id} events — a named field so a reconnect's
   *  addEventListener dedupes (the reconnectNow pattern in
   *  agent-terminal.ts). */
  private readonly onPanePopOut = (e: Event): void => {
    this.popTerminal((e as CustomEvent<{ id: TerminalId }>).detail.id);
  };

  connectedCallback(): void {
    this.addEventListener('terminal-pop-out', this.onPanePopOut);
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
    // addTabButton + updateTabButton: the bar renders with the state's
    // dots/labels immediately — live flags are in hand, no poll needed.
    for (const [i, t] of ws.terminals.entries()) {
      this.addTabButton(t);
      this.updateTabButton(t, i);
    }
    this.appendEditorTab();
    this.appendPlusButton();
    this.body.appendChild(this.runPaneHost());
    const initial =
      initialTab !== undefined && ws.terminals.some(t => t.id === initialTab) ? initialTab : null;
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

  // ---- pop-out ----

  /** Pop a tab's terminal out to its own tab (/?t=<id> re-attaches it
   *  there through the deep-link path). MOVE, not copy: the popped
   *  tab's `tmux attach -d` would detach this page's pane the moment it
   *  attached, so the pane goes first — its socket closes, the SESSION
   *  survives (destroy(), not the close-terminal kill). The row stays,
   *  marked popped; the terminal returns on the popped tab's pagehide
   *  or the tab's next click. */
  popTerminal(id: TerminalId): void {
    if (!this.ws || !this.ws.terminals.some(t => t.id === id)) return;
    const existing = this.popped.get(id);
    if (existing) {
      if (!existing.closed) {
        existing.focus();
        return;
      } // already popped: the click focuses its tab
      this.unpop(id); // its tab died without a pagehide (crash): stale mark
    }
    // Open BEFORE tearing down: a refused open (this is the user-gesture
    // call) must leave the pane exactly as it was. No features string:
    // '_blank' alone is the browser's own NEW TAB, not a sized popup.
    const win = window.open(`${BASE}/?t=${id}`, '_blank');
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
    // HOOK(popout-toolbar): the MOVE's teardown half — close this page's
    // pane socket BEFORE the popped tab can attach, so its `attach -d`
    // finds no client to detach (both attached, they would bump each
    // other; reusing the close-terminal path here would instead KILL the
    // tmux session the popped tab is about to open). destroyPane only
    // closes the socket: the session survives for the popped tab's
    // attach.
    this.destroyPane(id);
    this.markPopped(id, true);
    this.showPoppedNotice();
    // The pagehide listener rides the popped tab's window object, which
    // same-origin navigation REUSES — so the initial about:blank →
    // /?t=<id> swap fires pagehide too. Count it only once the tab is
    // really gone (a swap leaves it open; a close flips `closed`), checked
    // after a beat to let the close settle.
    win.addEventListener('pagehide', () => {
      setTimeout(() => {
        if (win.closed) this.popupClosed(id, win);
      }, POPUP_GONE_MS);
    });
  }

  /** The popped tab went away (its pagehide reaches this page through
   *  the handle — same origin). The active popped tab re-attaches here
   *  right away; an inactive one just drops its mark (its next
   *  activation attaches a fresh pane). */
  private popupClosed(id: TerminalId, win: Window): void {
    if (this.popped.get(id) !== win) return; // reclaimed / re-popped / torn down meanwhile
    this.unpop(id);
    if (this.active === id) this.selectTerminal(id);
  }

  /** Drop a tab's popped mark (its tab, if any, is no longer this
   *  page's to manage — an old handle's pagehide is ignored above). */
  private unpop(id: TerminalId): void {
    if (this.popped.delete(id)) this.markPopped(id, false);
  }

  /** The popped class on a tab's row button (dimmed — its terminal
   *  lives in another tab) — and its aria label NOW, not at
   *  the next sync poll (updateTabButton recomputes the same string from
   *  state, so the two can never disagree). */
  private markPopped(id: TerminalId, on: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.classList.toggle('popped', on);
    const ws = this.ws;
    const i = ws ? ws.terminals.findIndex(t => t.id === id) : -1;
    if (i >= 0) this.updateTabButton(ws!.terminals[i]!, i);
  }

  /** The body's "this terminal is elsewhere" notice — the popped tab
   *  stays selected, so its pane's spot must say where it went. */
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

  /** Activate a terminal tab: creates the pane (and its WS attach) on
   *  first activation, shows it, hides every other pane. A pane whose
   *  attach ENDED (the session died out-of-band — plan §4's dead tab) is
   *  destroyed and re-created, so the click is a fresh attach and the
   *  server respawns the session at the workspace cwd. */
  selectTerminal(id: TerminalId): void {
    if (!this.body || !this.ws || !this.ws.terminals.some(t => t.id === id)) return;
    this.hideRun();
    this.clearNoTerminals();
    this.clearPoppedNotice();
    // A popped tab's click is a bring-back: drop the mark and let the
    // pane below re-attach (its `attach -d` bumps the popped tab's
    // client — once; the popped tab's 'exit' ends its attach, no loop).
    if (this.popped.has(id)) this.unpop(id);
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
    this.clearPoppedNotice();
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

  private appendPlusButton(): void {
    if (!this.bar || !this.ws) return;
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'tab-new';
    plus.title = 'new terminal tab';
    plus.setAttribute('aria-label', 'new terminal tab');
    plus.innerHTML = `<wa-icon name="plus" aria-hidden="true"></wa-icon>`;
    plus.addEventListener('click', () =>
      this.dispatchEvent(
        new CustomEvent('new-terminal', {
          detail: { workspaceId: this.ws?.id },
          bubbles: true,
          composed: true,
        }),
      ),
    );
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
   *  the spike's ?folder= shape (URI-encoded, editorSrc above). */
  private ensureEditorPane(): void {
    if (this.editorPane || !this.body || !this.ws) return;
    armEditorThemeReload();
    const frame = document.createElement('iframe');
    frame.className = 'editor-frame hidden';
    frame.title = 'editor';
    frame.src = editorSrc(this.ws.cwd);
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
   *  run pane, the bar's buttons, the popped marks (their tabs stay
   *  open — an old handle's pagehide is a no-op in popupClosed). The
   *  bar/body shells stay. */
  private teardownPanes(): void {
    for (const id of [...this.panes.keys()]) this.destroyPane(id);
    this.tabs.clear();
    this.popped.clear();
    this.clearPoppedNotice();
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
