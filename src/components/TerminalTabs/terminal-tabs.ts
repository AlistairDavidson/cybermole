// <terminal-tabs>: the selected workspace's tab bar and panes. Each tab's
// <agent-terminal> is created on first activation and stays connected while
// hidden. The editor tab (an iframe of the /editor proxy) is pinned last.
// Bar updates are granular node moves and class flips, never innerHTML
// swaps, so listeners and focus survive.
//
// Pop-out moves a terminal to its own browser tab (/?t=<id>). It's a move,
// not a copy: the server attaches with `tmux attach -d`, so two clients
// would bump each other. The pane's socket closes but the session survives;
// the terminal comes back when the popped tab closes or this tab is clicked.
//
// Emits (bubbling, handled by <console-app>): new-terminal {workspaceId},
// close-terminal {id}, new-workspace {appId}, pop-blocked {id}.
import type { TerminalState, WorkspaceState } from '../../lib/platform/types';
import type { TerminalId, TmuxSessionName, WorkspaceId } from '@cybermole/app-kit';
import { BASE } from '../../base';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import type { AgentTerminal } from '../AgentTerminal/agent-terminal';
import '../AgentTerminal/agent-terminal';

/** A terminal id is a uuid, so no collision. */
const EDITOR = 'editor';

/** No theme param: the workbench only reads folder/workspace/ew from the
 *  URL. It follows the browser's scheme at boot instead, so a mode flip
 *  reloads the iframe. */
const editorSrc = (cwd: string): string => `${BASE}/editor/?folder=${encodeURIComponent(cwd)}`;

// On a colour-mode flip, reload any editor pane (re-assigning src reloads)
// so the workbench boots in the new mode. Its own live re-theming is
// unreliable. Only scroll position is lost.
let editorThemeArmed = false;
function armEditorThemeReload(): void {
  if (editorThemeArmed) return;
  editorThemeArmed = true;
  new MutationObserver(() => {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe.editor-frame'))
      frame.src = frame.src; // eslint-disable-line no-self-assign -- a reload, on purpose
  }).observe(document.documentElement, { attributeFilter: ['class'], attributes: true });
}

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
  private plusButton: HTMLButtonElement | null = null;
  private editorPane: HTMLIFrameElement | null = null;
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
    this.appendPlusButton();
    this.body.appendChild(this.runPaneHost());
    const initial =
      initialTab !== undefined && ws.terminals.some(t => t.id === initialTab) ? initialTab : null;
    if (initial !== null) this.selectTerminal(initial);
    else if (!this.selectFirstTerminal()) this.renderNoTerminals();
  }

  /** Granular reconcile with a fresh poll: nodes are moved, never rebuilt. */
  sync(ws: WorkspaceState): void {
    if (!this.bar || this.ws?.id !== ws.id) return;
    this.ws = ws;
    // appendChild moves buttons into state order; editor and + stay last.
    for (const t of ws.terminals) {
      if (!this.tabs.has(t.id)) this.addTabButton(t);
      this.bar.appendChild(this.tabs.get(t.id)!);
    }
    if (this.editorTab) this.bar.appendChild(this.editorTab);
    if (this.plusButton) this.bar.appendChild(this.plusButton);
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
    this.destroyPane(id);
    this.markPopped(id, true);
    this.showPoppedNotice();
    // Same-origin navigation reuses the window, so the about:blank → /?t=
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
    this.editorPane?.classList.add('hidden');
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
    if (this.editorPane || !this.body || !this.ws) return;
    armEditorThemeReload();
    const frame = document.createElement('iframe');
    frame.className = 'editor-frame hidden';
    frame.title = 'editor';
    frame.src = editorSrc(this.ws.cwd);
    this.body.appendChild(frame);
    this.editorPane = frame;
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
    this.editorTab?.classList.toggle('active', this.active === EDITOR);
    this.editorTab?.setAttribute('aria-selected', this.active === EDITOR ? 'true' : 'false');
  }
}

if (!customElements.get('terminal-tabs')) customElements.define('terminal-tabs', TerminalTabs);
