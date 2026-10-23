// agent-terminal.ts — <agent-terminal>: xterm.js over websocket to node-pty/tmux.
// Light DOM (xterm injects its own styles; global CSS applies). One live
// instance per terminal tab (plan §8): <terminal-tabs> keeps hidden tabs
// connected (state and scrollback persist, matching how tmux detach works)
// and calls activate() on show — the WebGL renderer loads on a tab's FIRST
// activation only (browsers cap live WebGL contexts at ~8–16; a
// never-activated tab must never hold one).
// Connection life: attach() opens a socket for one target. If it drops
// without the server ending the attach (proxy idle cut, server restart,
// network blip), the status says so and the terminal reattaches with the
// SAME attach frame — mode included — with backoff. The server's
// 'exit' / 'error' / 'signed-out'
// end an attach for good — no reconnect, so two tabs bumping each other off
// a session (`attach -d`) can't loop, and a logged-out token stays logged
// out. 'restart' (server shutdown) is the exception that reconnects: tmux
// keeps the session, and the backoff lands back on it once it's back.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon, type ISearchDecorationOptions } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import type { ActiveKey, ClientMsg, ServerMsg } from '../../lib/types';
import type { TerminalId, TmuxSessionName } from '../../types/branded';
import { parseBackfillMsg } from '../../schemas/frames';
import { BASE } from '../../base';

/** Max UTF-16 units per input frame. JSON spends at most 6 bytes on one
 *  unit (\u001b-style escapes), so a frame stays under ~384 KiB — inside
 *  the server's 1 MiB maxPayload however big the paste is. */
const INPUT_CHUNK = 64 * 1024;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

/** Input split into frames of at most INPUT_CHUNK units, never between the
 *  halves of a surrogate pair (a lone half would reach the pty as U+FFFD). */
function chunkInput(data: string): string[] {
  if (data.length <= INPUT_CHUNK) return [data];
  const out: string[] = [];
  for (let i = 0; i < data.length;) {
    let end = Math.min(i + INPUT_CHUNK, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

/** Plain-text transcript of a terminal's whole buffer — scrollback
 *  included — one line per buffer row, trailing blank rows (a fresh
 *  pane's never-written rows) trimmed. The walk behind "copy output";
 *  exported for tests.
 *
 *  Which buffer that IS depends on the attach: while a pane is attached,
 *  tmux holds the client terminal in the ALTERNATE screen (no client-side
 *  scrollback — tmux's own history lives server-side, exactly what the
 *  task/terminal-search backfill TODO is about), so this walks the
 *  visible screen; once the alt screen is left (pre-attach, an ended
 *  pane), buffer.active is the normal buffer and the walk carries its
 *  scrollback. Either way it is exactly what the user is looking at. */
export function terminalPlainText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** Every connected instance — the online/visibility reconnect wake-up is
 *  shared (one window/document listener pair for the whole page, not one
 *  per terminal tab: the singleton-era listeners would multiply with the
 *  tab count; the manager fans the event out to whoever has a pending
 *  backoff). */
const instances = new Set<AgentTerminal>();
let sharedWakeArmed = false;
const wakePendingReconnects = (): void => {
  if (document.visibilityState === 'hidden') return;
  for (const t of instances) t.reconnectNow();
};
function armSharedWake(): void {
  if (sharedWakeArmed) return;
  sharedWakeArmed = true;
  window.addEventListener('online', wakePendingReconnects);
  document.addEventListener('visibilitychange', wakePendingReconnects);
}

// ---- find bar (the @xterm/addon-search face) ----

/** Query state is module-level on purpose, never in the pane's DOM: pane
 *  elements are discarded on workspace switches, and the sidebar's 15 s
 *  innerHTML poll would eat DOM state anyway (AGENTS.md). Per-target
 *  (ActiveKey) with the last query as the fallback for a target never
 *  searched — the browser's own find bar behaves the same way. */
const findQueries = new Map<ActiveKey, string>();
let lastFindQuery = '';
/** Live-search debounce while typing (ms). */
const FIND_DEBOUNCE_MS = 150;

/** Search-highlight colours, resolved once from the app's tokens in
 *  console.css :root — the one sanctioned home of hex. The addon paints
 *  literal #RRGGBB onto the canvas/overview ruler, so Web Awesome tokens
 *  (var() chains — a custom-property read returns the raw, unresolved
 *  stream) can't be used; the literals are read here instead. null when
 *  they don't resolve: find still runs, just unhighlighted. */
let findDecorations: ISearchDecorationOptions | null | undefined;
function resolveFindDecorations(): ISearchDecorationOptions | undefined {
  if (findDecorations === undefined) {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name: string): string => cs.getPropertyValue(name).trim();
    const match = pick('--cybermole-find-match');
    const active = pick('--cybermole-find-match-active');
    const overview = pick('--cybermole-find-overview');
    const activeOverview = pick('--cybermole-find-overview-active');
    findDecorations =
      match !== '' && active !== '' && overview !== '' && activeOverview !== ''
        ? {
            matchBackground: match,
            activeMatchBackground: active,
            matchOverviewRuler: overview,
            activeMatchColorOverviewRuler: activeOverview,
          }
        : null;
  }
  return findDecorations ?? undefined;
}

/** Is the given element a real text field the user might be typing into
 *  (the sidebar's filter, a dialog input)? Ctrl+F is theirs, not the
 *  terminal's. The check probes shadow roots too: a wa-* form control's
 *  real input lives inside its shadow DOM, and focus can sit on the HOST
 *  (verified: after filling the sidebar filter, activeElement is the
 *  <wa-input> host, not its inner input). Exception: anything INSIDE an
 *  <agent-terminal> — most notably xterm's own hidden helper textarea,
 *  which is exactly the "terminal pane is the active context" case the
 *  find bar is FOR (the find bar's input lives in there too, where
 *  re-opening re-selects the query, like the browser's own find bar). */
const inTextField = (el: Element | null): boolean => {
  if (el === null) return false;
  if (el.closest('agent-terminal') !== null) return false;
  if ((el as HTMLElement).isContentEditable || el.matches('input, textarea, select')) return true;
  return el.shadowRoot?.querySelector('input, textarea, select') != null;
};

/** One capture-phase document listener for every pane (the shared-wake
 *  pattern): Ctrl+F / Cmd+F opens the visible pane's find bar. Capture so
 *  it runs before xterm's own key handling — preventDefault stops the
 *  browser's native find (the \x06 the terminal would send is dropped by
 *  the per-terminal custom key handler instead; xterm ignores a later
 *  preventDefault). */
let sharedFindArmed = false;
const openFindOnCtrlF = (e: KeyboardEvent): void => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return;
  if (inTextField(document.activeElement)) return;
  for (const t of instances) {
    if ((t as unknown as HTMLElement).classList.contains('hidden')) continue;
    e.preventDefault();
    t.openFind();
    return;
  }
};
function armSharedFind(): void {
  if (sharedFindArmed) return;
  sharedFindArmed = true;
  document.addEventListener('keydown', openFindOnCtrlF, true);
}

export class AgentTerminal extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['status'];
  }

  terminal?: Terminal;
  fitXtermAddon?: FitAddon;
  serializeXtermAddon?: SerializeAddon;
  searchAddon?: SearchAddon;
  websocket?: WebSocket;
  activeKey?: ActiveKey;
  resizeObserver?: ResizeObserver;
  /** The pane's overlay toolbar (.terminal-toolbar) — the find bar's
   *  host; shared contract with task/terminal-transcript (see
   *  ensureToolbar). */
  toolbar: HTMLElement | null = null;
  private findBar: HTMLElement | null = null;
  private findInput: (HTMLElement & { value: string | null; focus(): void }) | null = null;
  private findDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Has anything been written into the buffer since the last reset?
   *  Gates the 'backfill' write: a reconnect's terminal already holds
   *  the session (reconnect() keeps the buffer), so backfilling again
   *  would duplicate the history. */
  private bufferPrimed = false;
  /** tmux session the server last attached us to — set on 'attached'. */
  private attachedTarget: TmuxSessionName | null = null;
  /** The tab uuid this pane attaches as ('terminal' mode; null on a run
   *  pane) — the toolbar's pop-out button's identity. attach() is the
   *  one place the mode is known, so it drives the button there. */
  private terminalId: TerminalId | null = null;
  /** Is the current attach OVER for good (never attached, or ended by
   *  the server's 'exit'/'error'/'signed-out')? Read by <terminal-tabs>:
   *  a tab whose pane has ended gets a FRESH attach on its next click —
   *  the dead-tab story (plan §4: the row is the structure; the first
   *  attach retries the spawn). A dropped-but-reconnecting attach is NOT
   *  ended — the pane handles its own reconnection. */
  ended = true;
  /** The attach frame this element STARTED with (terminal id / run
   *  target — plan §7): a reconnect re-sends it, so the
   *  attach keeps its mode — a terminal tab whose session died mid-drop
   *  gets the §4 respawn instead of 'no such live session', and a run
   *  attach never morphs into a respawn. Cleared when attach() starts a
   *  new target. */
  private attachMsg: ClientMsg | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  /** Back online / every tab visible again: skip the rest of a pending
   *  backoff. Public for the shared manager above only (never
   *  per-instance listeners — the singleton-era design multiplied them
   *  with the tab count). */
  readonly reconnectNow = (): void => {
    if (this.reconnectTimer === null || document.visibilityState === 'hidden') return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnect();
  };

  connectedCallback(): void {
    instances.add(this);
    armSharedWake();
    this.ensureToolbar();
    armSharedFind();
    if (this.terminal) {
      return;
    }

    const terminalContainer = this.querySelector('.terminal-container') as HTMLElement;

    const surfaceColor =
      getComputedStyle(this).getPropertyValue('--wa-color-surface-default').trim() || '#11131a';

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'monospace',
      scrollback: 5000,
      // @xterm/addon-search's highlight decorations ride xterm's proposed
      // API (registerDecoration), which xterm 6 gates behind this flag —
      // the addon throws "You must set the allowProposedApi option" on
      // every find otherwise.
      allowProposedApi: true,
      theme: {
        background: surfaceColor,
      },
    });

    this.fitXtermAddon = new FitAddon();
    this.terminal.loadAddon(this.fitXtermAddon);

    this.serializeXtermAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeXtermAddon);
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);

    this.terminal.open(terminalContainer);

    // Ctrl+F / Cmd+F is the find bar's while the terminal has focus:
    // xterm ignores a later preventDefault (verified — the \x06 still
    // goes to the pty), so its documented hook drops the key at the
    // source instead. The shared document listener (armSharedFind) still
    // preventDefaults the BROWSER's native find and opens the bar.
    this.terminal.attachCustomKeyEventHandler(e => {
      if (
        e.type === 'keydown' &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === 'f'
      )
        return false;
      return true;
    });

    // URLs in agent output become clickable (a custom handler — e.g.
    // copy-to-clipboard instead of navigate — can come later).
    this.terminal.loadAddon(new WebLinksAddon());

    this.fitNow();

    // A paste arrives as one onData call of any size — sent as consecutive
    // frames, which the server writes to the pty in order.
    this.terminal.onData(d => {
      for (const data of chunkInput(d)) this.send({ type: 'input', data });
    });

    this.terminal.onResize(() => this.sendSize());

    this.resizeObserver = new ResizeObserver(() => this.fitNow());
    this.resizeObserver.observe(terminalContainer);

    this.ensureToolbar();

    this.fitNow();
    // NB: the WebGL renderer is NOT loaded here — only on activate()
    // (first time the tab is on screen; plan §8's context cap).
  }

  disconnectedCallback(): void {
    instances.delete(this);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  private send(msg: ClientMsg): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(msg));
    }
  }

  private sendSize(): void {
    if (this.terminal) {
      this.send({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows });
    }
  }

  /** fit() guarded against a hidden (display:none) box: a hidden tab's
   *  ResizeObserver fires at 0×0, and fitting there would collapse the
   *  terminal to nonsense dims — skip instead; the re-show's refit() is
   *  the moment a hidden tab's size is settled. Returns whether a real
   *  box was fitted. */
  private fitNow(): boolean {
    const box = this.querySelector('.terminal-container') as HTMLElement | null;
    if (!box || box.clientWidth === 0 || box.clientHeight === 0) return false;
    this.fitXtermAddon?.fit();
    return true;
  }

  private status(text: string, kind: 'busy' | 'ok' | 'err' | 'info' = 'busy'): void {
    const el = this.querySelector('.terminal-status');
    if (!el) return;
    const indicator =
      kind === 'busy'
        ? '<wa-spinner></wa-spinner>'
        : kind === 'ok'
          ? '<wa-icon name="circle-check"></wa-icon>'
          : kind === 'err'
            ? '<wa-icon name="triangle-exclamation"></wa-icon>'
            : '<wa-icon name="circle-info"></wa-icon>';
    el.className = `terminal-status ${kind}`;
    el.innerHTML = `${indicator}<span></span>`;
    (el.lastElementChild as HTMLElement).textContent = text;
  }

  // ---- toolbar: transcript actions ----

  /** The pane's toolbar, overlaid top-right over .terminal-container
   *  (console.css: position absolute, so it is never in the container's
   *  flow — the ResizeObserver fit must keep seeing the container's true
   *  box, AGENTS.md). Rebuilt here on every (re)connect when missing, so
   * every pane creation path (AgentTerminal.astro, <terminal-tabs>'s
   * innerHTML panes) gets it without duplicating markup. */
  private ensureToolbar(): void {
    if (this.querySelector('.terminal-toolbar')) return;
    const bar = document.createElement('div');
    bar.className = 'terminal-toolbar wa-cluster wa-gap-s';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'terminal actions');
    const find = document.createElement('div');
    find.className = 'terminal-find wa-cluster hidden';
    find.innerHTML = `
      <wa-input class="terminal-find-input" placeholder="find in terminal…" size="s"
        aria-label="find in terminal"></wa-input>
      <wa-button class="find-prev" appearance="plain" size="xs" title="previous match (shift+enter)">
        <wa-icon name="chevron-up" label="previous match"></wa-icon>
      </wa-button>
      <wa-button class="find-next" appearance="plain" size="xs" title="next match (enter)">
        <wa-icon name="chevron-down" label="next match"></wa-icon>
      </wa-button>
      <wa-button class="find-close" appearance="plain" size="xs" title="close (esc)">
        <wa-icon name="xmark" label="close find bar"></wa-icon>
      </wa-button>`;
    bar.innerHTML = `
      <wa-button class="tb-pop-out hidden" appearance="plain" variant="neutral" size="xs"
          title="pop out — move this terminal to its own browser tab (its row here brings it back)">
        <wa-icon slot="start" name="arrow-up-right-from-square" aria-hidden="true"></wa-icon>pop out
      </wa-button>
      <wa-button class="tb-copy-output" appearance="plain" variant="neutral" size="xs"
          title="copy the terminal's output — scrollback included — as plain text">
        <wa-icon slot="start" name="copy" aria-hidden="true"></wa-icon>copy
      </wa-button>
      <wa-button class="tb-download-transcript" appearance="plain" variant="neutral" size="xs"
          title="download the transcript — scrollback included, ANSI colors preserved">
        <wa-icon slot="start" name="download" aria-hidden="true"></wa-icon>download
      </wa-button>`;
    // Pop-out (task/popout-toolbar): FIRST action — it MOVES the pane,
    //  the others only read it. Rendered hidden and revealed by attach():
    //  only a 'terminal' attach has a tab to pop out to — the run pane
    //  (?run= job viewer) is not a workspace terminal and has no row to
    //  bring the terminal back, so it never gets the button. The click
    //  is dispatched, not handled here: the pane knows its id, but the
    //  MOVE semantics (open-before-teardown, popped marks, bring-back)
    //  belong to <terminal-tabs> (every pane's ancestor), which catches
    //  the bubbled event and routes it to popTerminal().
    (bar.querySelector('.tb-pop-out') as HTMLElement).addEventListener('click', () => {
      const id = this.terminalId;
      if (id === null) return;
      this.dispatchEvent(
        new CustomEvent('terminal-pop-out', {
          detail: { id },
          bubbles: true,
          composed: true,
        }),
      );
    });
    (bar.querySelector('.tb-copy-output') as HTMLElement).addEventListener(
      'click',
      () => void this.copyOutput(),
    );
    (bar.querySelector('.tb-download-transcript') as HTMLElement).addEventListener('click', () =>
      this.downloadTranscript(),
    );
    bar.insertBefore(find, bar.firstChild);
    this.toolbar = bar;
    this.findBar = find;
    const input = find.querySelector('.terminal-find-input') as
      (HTMLElement & { value: string | null; focus(): void }) | null;
    this.findInput = input;
    if (input) {
      // wa-input emits a plain `input` event per keystroke (same as the
      // sidebar's filter); .value is null when empty.
      input.addEventListener('input', () => this.onFindInput());
      // Enter=next, Shift+Enter=prev, Esc=close + refocus the terminal.
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.runFind(this.findQuery(), e.shiftKey);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.closeFind();
        }
      });
    }
    (find.querySelector('.find-next') as HTMLElement | null)?.addEventListener('click', () =>
      this.runFind(this.findQuery(), false),
    );
    (find.querySelector('.find-prev') as HTMLElement | null)?.addEventListener('click', () =>
      this.runFind(this.findQuery(), true),
    );
    (find.querySelector('.find-close') as HTMLElement | null)?.addEventListener('click', () =>
      this.closeFind(),
    );
    const status = this.querySelector('.terminal-status');
    if (status) status.before(bar);
    else this.appendChild(bar);
  }

  /** The plain-text transcript (terminalPlainText above) — public so
   *  tests (and any future plain-text export) can read it without the
   *  clipboard. */
  transcriptText(): string {
    return this.terminal ? terminalPlainText(this.terminal) : '';
  }

  /** Toast through the app's stack: <console-app>'s <wa-toast> (the
   *  nearest) when the pane is in the console, else the layout's
   *  (Base.astro renders one on every page). */
  private toast(message: string, options?: Record<string, unknown>): void {
    const host = (this.closest('console-app') ?? document).querySelector('wa-toast') as
      | (HTMLElement & { create?: (message: string, options?: Record<string, unknown>) => unknown })
      | null;
    if (host?.create) host.create(message, options);
  }

  /** "copy output": the whole buffer as plain text onto the clipboard.
   *  writeText rejects on a denied permission or an insecure context —
   *  a toast, never a throw out of a click handler. */
  private async copyOutput(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.transcriptText());
      this.toast('copied the terminal output', {
        variant: 'neutral',
        icon: 'circle-check',
        duration: 4000,
      });
    } catch {
      this.toast('could not copy — clipboard unavailable or denied', {
        variant: 'danger',
        icon: 'triangle-exclamation',
        duration: 6000,
      });
    }
    this.terminal?.focus();
  }

  /** "download transcript": the serialize addon's ANSI artifact — the
   *  whole buffer (scrollback included) WITH its SGR colors and cursor
   *  state, so the file replays faithfully in any terminal (`less -R`,
   *  cat, xterm). .ans is the primary download artifact because the
   *  color/positioning information is exactly what a plain-text walk
   *  (the copy button) throws away; anyone needing plain text on disk
   *  can paste the copy. While attached, that "whole buffer" is tmux's
   *  alternate screen (see terminalPlainText — the client-side reality
   *  until task/terminal-search's backfill); the normal buffer and its
   *  scrollback ride along whenever one exists. Named after the attached
   *  session (t-<uuid>, or the run's cybermole-<name>) — the tab's identity
   *  on both attach modes. */
  private downloadTranscript(): void {
    const content = this.serializeXtermAddon ? this.serializeXtermAddon.serialize() : '';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.attachedTarget ?? 'terminal'}-transcript.ans`;
    link.click();
    // the download keeps the blob alive; the URL can't be revoked before
    // the browser has taken it (30 s covers the largest scrollbacks)
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    this.terminal?.focus();
  }

  private findQuery(): string {
    return this.findInput?.value ?? '';
  }

  /** Ctrl+F / Cmd+F (the shared listener) or a transcript hook: reveal
   *  the find bar with the pane's saved query (module-level state — the
   *  query survives pane switches), selected so typing replaces it, and
   *  a live search running. */
  openFind(): void {
    if (!this.terminal || !this.findBar || !this.findInput) return;
    this.findBar.classList.remove('hidden');
    const saved =
      (this.activeKey !== undefined ? findQueries.get(this.activeKey) : undefined) ?? lastFindQuery;
    this.findInput.value = saved;
    this.findInput.focus();
    const native =
      (this.findInput as unknown as { input?: HTMLInputElement }).input ??
      this.findInput.shadowRoot?.querySelector('input') ??
      null;
    if (native) native.select(); // typing replaces, like the browser's find
    if (saved) this.runFind(saved, false);
  }

  /** Esc / close button: hide, clear the decorations, hand focus back to
   *  the terminal (the next keystroke belongs to the shell). The query
   *  stays saved for the next open. */
  private closeFind(): void {
    if (this.findDebounce !== null) {
      clearTimeout(this.findDebounce);
      this.findDebounce = null;
    }
    this.searchAddon?.clearDecorations();
    this.findBar?.classList.add('hidden');
    this.terminal?.focus();
  }

  /** Typing in the find bar: remember the query (module-level, per
   *  activeKey + the global fallback) and run a debounced live search so
   *  the highlight decorations track the text as it's typed. */
  private onFindInput(): void {
    const q = this.findQuery();
    if (this.activeKey !== undefined) findQueries.set(this.activeKey, q);
    lastFindQuery = q;
    if (this.findDebounce !== null) clearTimeout(this.findDebounce);
    this.findDebounce = setTimeout(() => {
      this.findDebounce = null;
      this.runFind(q, false);
    }, FIND_DEBOUNCE_MS);
  }

  private runFind(query: string, backwards: boolean): void {
    const addon = this.searchAddon;
    if (!addon || !this.terminal) return;
    if (query === '') {
      addon.clearDecorations();
      return;
    }
    // findNext/findPrevious scroll the match into view and paint the
    // decorations; the addon keeps its own result cursor, so repeated
    // Enter steps through matches.
    if (backwards) addon.findPrevious(query, { decorations: resolveFindDecorations() });
    else addon.findNext(query, { decorations: resolveFindDecorations() });
  }

  attach(mode: 'terminal' | 'run', target: TerminalId | TmuxSessionName, key: ActiveKey): void {
    this.cancelReconnect();
    this.closeSocket();
    this.terminal?.reset();
    this.bufferPrimed = false; // fresh buffer: the next backfill belongs in it
    this.terminal?.focus();
    this.activeKey = key;
    this.attachedTarget = null;
    this.terminalId = mode === 'terminal' ? (target as TerminalId) : null;
    // the pop-out button rides the toolbar, whose build (ensureToolbar,
    // connectedCallback) runs before the mode is known — reveal it here
    this.toolbar
      ?.querySelector('.tb-pop-out')
      ?.classList.toggle('hidden', this.terminalId === null);
    this.ended = true;
    // 'terminal' carries the tab's uuid (the server derives t-<uuid>,
    // respawning if dead — plan §4); 'run' a live job run's session name
    // (never respawned).
    const msg: ClientMsg =
      mode === 'run' ? { type: 'attach', mode, target } : { type: 'attach', mode, id: target };
    this.attachMsg = msg;
    this.connect(msg, target, key);
  }

  /** Open a socket and send one attach. A close the server didn't announce
   *  (no 'exit' / 'error' first) after a successful attach reconnects. */
  private connect(msg: ClientMsg, label: string, key: ActiveKey): void {
    this.status(`connecting: ${label} …`, 'busy');

    // Browser WebSocket only accepts ws:/wss: — and the server's upgrade
    // handler (server/main.ts) serves ${BASE}/ws.
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const websocket = new WebSocket(`${proto}//${location.host}${BASE}/ws`);
    this.websocket = websocket;
    let ended = false; // the server ended this attach itself — don't reconnect
    let restarting = false; // the server announced a shutdown — DO reconnect

    websocket.onopen = () => {
      this.ended = false;
      websocket.send(JSON.stringify(msg));
      this.sendSize();
    };

    websocket.onmessage = ev => {
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (m.type === 'output') {
        this.bufferPrimed = true;
        this.terminal?.write(m.data);
      }
      // Scrollback backfill — the capture that ran on the server between
      // 'attached' and the first 'output'. Written only into a FRESH
      // buffer: a reconnect keeps its buffer (no reset), and backfilling
      // again would duplicate the history. The newline pad is the dedupe:
      // the captured history stops above the visible screen (-E -1), and
      // rows-1 newlines push the viewport down so tmux's attach redraw —
      // home-positioned (ESC[H) relative to the viewport top — repaints
      // the screen BELOW the backfilled history instead of over it.
      // (Verified end to end: each line appears exactly once.)
      else if (m.type === 'backfill') {
        const b = parseBackfillMsg(ev.data as string);
        if (!b || b.data === '' || this.bufferPrimed || !this.terminal) return;
        this.bufferPrimed = true;
        this.terminal.write(b.data);
        if (this.terminal.rows > 1) this.terminal.write('\n'.repeat(this.terminal.rows - 1));
      } else if (m.type === 'attached') {
        this.ended = false;
        this.attachedTarget = m.target;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.status(`attached: ${m.target} (${m.socket} socket)`, 'ok');
      } else if (m.type === 'error') {
        ended = true;
        this.ended = true;
        this.status(m.message, 'err');
        this.terminal?.write(`\r\n\u001b[31m${m.message}\u001b[0m\r\n`);
      } else if (m.type === 'exit') {
        ended = true;
        this.ended = true;
        this.status(`detached: ${m.target}`, 'info');
      }
      // The token this socket used was dropped (logout / log out
      // everywhere): final — like 'exit', never reconnected.
      else if (m.type === 'signed-out') {
        ended = true;
        this.ended = true;
        this.status('signed out', 'info');
        this.terminal?.write('\r\nsigned out\r\n');
      }
      // The server is shutting down (deploy, container stop): the
      // terminal reattaches with the usual backoff once the server is
      // back. The session itself survives only on a host install — there
      // tmux outlives the server; in the container the tmux server dies
      // with it, and the reattach lands on 'no such live session' (which
      // reads as ended, below) — the README's accepted trade.
      else if (m.type === 'restart') {
        restarting = true;
        this.status('server restarting — reconnecting …', 'busy');
      }
    };

    websocket.onclose = () => {
      if (this.websocket !== websocket) return; // superseded by attach() or a reconnect
      this.websocket = undefined;
      if (this.activeKey !== key) return;
      if (!ended) {
        if (this.attachedTarget)
          this.scheduleReconnect(restarting ? 'server restarting' : 'disconnected');
        else {
          this.ended = true;
          this.status(`could not connect: ${label}`, 'err');
        }
      }
      // The console re-polls state on every close — which also sends an
      // expired login back to the sign-in page instead of retrying forever.
      this.dispatchEvent(
        new CustomEvent('terminal-closed', { detail: key, bubbles: true, composed: true }),
      );
    };
  }

  /** End this element's connection for good — a tab being torn down
   *  (closed, or its workspace switched away), not a drop: no reconnect,
   *  and the socket closes before the element leaves the DOM so a
   *  discarded pane can never ride the keepalive forever. */
  destroy(): void {
    this.cancelReconnect();
    this.closeSocket();
  }

  private closeSocket(): void {
    const ws = this.websocket;
    this.websocket = undefined; // its onclose now sees it was superseded
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private scheduleReconnect(reason = 'disconnected'): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.status(`${reason} — reconnecting in ${Math.round(delay / 1000)}s …`, 'busy');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  /** Back to what this element last attached to; tmux redraws the screen
   *  and xterm keeps its scrollback (no reset). Mode-aware (plan §7): the
   *  re-send is the frame the attach STARTED with — a terminal tab gets
   *  the §4 respawn when its session died mid-drop, a run attach stays a
   *  run. */
  private reconnect(): void {
    const target = this.attachedTarget;
    const key = this.activeKey;
    const msg = this.attachMsg;
    if (!target || !key || !msg) return;
    this.connect(msg, target, key);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
  }

  /** A tab's first activation / re-show (plan §8): refit to the now-real
   *  box, re-send the size (the pty kept the pre-hide dims while the tab
   *  was hidden — tmux only learns a new size through a client), focus,
   *  and load the WebGL renderer on the FIRST activation only. */
  activate(): void {
    this.ensureWebgl();
    this.fitNow();
    this.sendSize();
    this.terminal?.focus();
  }

  /** WebGL renderer — the big win for pi's full-screen TUI redraws, and
   *  the resource browsers cap hardest (~8–16 live contexts: past that
   *  the OLDEST context is lost and that terminal corrupts). Loaded
   *  exactly once per instance, only once the tab has been on screen — a
   *  never-activated tab never holds one. Disposing the addon (on context
   *  loss; or never loading it if WebGL is missing) leaves xterm on its
   *  built-in DOM renderer. */
  private webglTried = false;
  private ensureWebgl(): void {
    if (this.webglTried) return;
    this.webglTried = true;
    void import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (!this.terminal) return;
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          this.terminal.loadAddon(webgl);
        } catch {
          /* no WebGL: stay on the DOM renderer */
        }
      })
      .catch(() => {
        /* chunk failed to load: stay on the DOM renderer */
      });
  }
}

if (!customElements.get('agent-terminal')) customElements.define('agent-terminal', AgentTerminal);
