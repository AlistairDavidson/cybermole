// <agent-terminal>: xterm.js over a WebSocket to node-pty/tmux. Light DOM,
// so global CSS applies. <terminal-tabs> keeps hidden tabs connected and
// calls activate() on show; WebGL loads on first activation only, since
// browsers cap live WebGL contexts at ~8–16.
//
// A drop the server didn't announce reconnects with backoff, re-sending the
// same attach frame. 'exit', 'error' and 'signed-out' end an attach for good,
// so two tabs bumping each other off a session (`attach -d`) can't loop.
// 'restart' (server shutdown) reconnects.
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon, type ISearchDecorationOptions } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import type { ActiveKey, ClientMsg, ServerMsg } from '../../lib/platform/types';
import type { TerminalId, TmuxSessionName } from '@cybermole/app-kit';
import { parseBackfillMsg } from '../../schemas/frames';
import { BASE } from '../../base';

/** JSON spends at most 6 bytes per UTF-16 unit, so a frame stays under
 *  ~384 KiB, inside the server's 1 MiB maxPayload. */
const INPUT_CHUNK = 64 * 1024;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

/** Never splits a surrogate pair (a lone half reaches the pty as U+FFFD). */
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

/** The active buffer as plain text, trailing blank rows trimmed. While tmux
 *  is attached that's the alternate screen (no client-side scrollback);
 *  otherwise the normal buffer with its scrollback. Exported for tests. */
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

/** One page-wide online/visibility listener pair for all instances, rather
 *  than a pair per tab. */
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

// ---- find bar ----

/** Module-level, not in the DOM: panes are discarded on workspace switches.
 *  Per target, falling back to the last query (like the browser's find). */
const findQueries = new Map<ActiveKey, string>();
let lastFindQuery = '';
const FIND_DEBOUNCE_MS = 150;

/** The html class the theme-boot script sets ('wa-dark' | 'wa-light', or ''). */
function currentColorMode(): string {
  const cls = document.documentElement.classList;
  return cls.contains('wa-dark') ? 'wa-dark' : cls.contains('wa-light') ? 'wa-light' : '';
}

/** The addon paints literal colours onto the canvas, so CSS var() chains
 *  won't do; the hex values are read from console.css's tokens. Cached per
 *  mode. null when they don't resolve: find still works, unhighlighted. */
let findDecorations: ISearchDecorationOptions | null | undefined;
let findDecorationsMode: string | null = null;
function resolveFindDecorations(): ISearchDecorationOptions | undefined {
  const mode = currentColorMode();
  if (findDecorations === undefined || findDecorationsMode !== mode) {
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
    findDecorationsMode = mode;
  }
  return findDecorations ?? undefined;
}

/** Ctrl+F belongs to a focused text field, not the terminal. Probes shadow
 *  roots, since focus can sit on a wa-input host. Anything inside an
 *  <agent-terminal> (xterm's helper textarea, the find input) doesn't count. */
const inTextField = (el: Element | null): boolean => {
  if (el === null) return false;
  if (el.closest('agent-terminal') !== null) return false;
  if ((el as HTMLElement).isContentEditable || el.matches('input, textarea, select')) return true;
  return el.shadowRoot?.querySelector('input, textarea, select') != null;
};

/** Capture phase, to beat xterm's key handling and preventDefault the
 *  browser's own find. (The \x06 xterm would send is dropped by each
 *  terminal's custom key handler.) */
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

// ---- color mode ----

/** Built from console.css's --cybermole-xterm-* tokens for the current mode;
 *  keys that don't resolve fall back to xterm's defaults. */
function resolveXtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string): string | undefined => {
    const value = cs.getPropertyValue(name).trim();
    return value === '' ? undefined : value;
  };
  const bright = (name: string): string | undefined => pick(`--cybermole-xterm-${name}-bright`);
  const plain = (name: string): string | undefined => pick(`--cybermole-xterm-${name}`);
  return {
    background: plain('background'),
    foreground: plain('foreground'),
    cursor: plain('cursor'),
    cursorAccent: plain('cursor-accent'),
    selectionBackground: plain('selection-background'),
    black: plain('black'),
    red: plain('red'),
    green: plain('green'),
    yellow: plain('yellow'),
    blue: plain('blue'),
    magenta: plain('magenta'),
    cyan: plain('cyan'),
    white: plain('white'),
    brightBlack: bright('black'),
    brightRed: bright('red'),
    brightGreen: bright('green'),
    brightYellow: bright('yellow'),
    brightBlue: bright('blue'),
    brightMagenta: bright('magenta'),
    brightCyan: bright('cyan'),
    brightWhite: bright('white'),
  };
}

/** Watches html's class rather than matchMedia, so it runs after the
 *  theme-boot script's flip, when the tokens already resolve to the new mode. */
let sharedThemeArmed = false;
function armSharedThemeSync(): void {
  if (sharedThemeArmed) return;
  sharedThemeArmed = true;
  new MutationObserver(() => {
    for (const t of instances) t.refreshColorMode();
  }).observe(document.documentElement, {
    attributeFilter: ['class'],
    attributes: true,
  });
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
  toolbar: HTMLElement | null = null;
  private findBar: HTMLElement | null = null;
  private findInput: (HTMLElement & { value: string | null; focus(): void }) | null = null;
  private findDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Gates the backfill: a reconnect keeps its buffer, so backfilling again would duplicate history. */
  private bufferPrimed = false;
  private attachedTarget: TmuxSessionName | null = null;
  /** The tab id in 'terminal' mode (null for a run pane); drives the pop-out button. */
  private terminalId: TerminalId | null = null;
  /** True until attached, and after 'exit'/'error'/'signed-out'. <terminal-tabs>
   *  gives an ended pane a fresh attach on its next click. A reconnecting
   *  pane is not ended. */
  ended = true;
  /** Re-sent on reconnect so the attach keeps its mode: a terminal tab whose
   *  session died gets respawned, and a run attach never becomes one. */
  private attachMsg: ClientMsg | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  /** Skip the rest of a pending backoff. Called by the shared listener. */
  readonly reconnectNow = (): void => {
    if (this.reconnectTimer === null || document.visibilityState === 'hidden') return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnect();
  };

  connectedCallback(): void {
    instances.add(this);
    armSharedWake();
    armSharedThemeSync();
    this.ensureToolbar();
    armSharedFind();
    if (this.terminal) {
      return;
    }

    const terminalContainer = this.querySelector('.terminal-container') as HTMLElement;

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'monospace',
      scrollback: 5000,
      // The search addon's highlights need xterm's proposed API.
      allowProposedApi: true,
      theme: resolveXtermTheme(),
    });

    this.fitXtermAddon = new FitAddon();
    this.terminal.loadAddon(this.fitXtermAddon);

    this.serializeXtermAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeXtermAddon);
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);

    this.terminal.open(terminalContainer);

    // xterm ignores a later preventDefault (the \x06 still reaches the
    // pty), so drop Ctrl+F here.
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

    this.terminal.loadAddon(new WebLinksAddon());

    this.fitNow();

    // A paste of any size arrives as one onData; send it in chunks.
    this.terminal.onData(d => {
      for (const data of chunkInput(d)) this.send({ type: 'input', data });
    });

    this.terminal.onResize(() => this.sendSize());

    this.resizeObserver = new ResizeObserver(() => this.fitNow());
    this.resizeObserver.observe(terminalContainer);

    this.ensureToolbar();

    this.fitNow();
    // WebGL loads in activate(), not here.
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

  /** A hidden tab's ResizeObserver fires at 0×0; fitting there would
   *  collapse the terminal, so skip until it's shown. */
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

  // ---- toolbar ----

  /** Absolutely positioned, so the ResizeObserver still sees the container's
   *  true box. Built here so every pane creation path gets it. */
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
    // Pop-out is only revealed by attach() for 'terminal' mode: a run pane
    // has no tab to come back to. The move itself belongs to <terminal-tabs>,
    // which catches the bubbled event.
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
      // wa-input fires `input` per keystroke; .value is null when empty.
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

  /** Public for tests. */
  transcriptText(): string {
    return this.terminal ? terminalPlainText(this.terminal) : '';
  }

  /** <console-app>'s toast when in the console, else the layout's. */
  private toast(message: string, options?: Record<string, unknown>): void {
    const host = (this.closest('console-app') ?? document).querySelector('wa-toast') as
      | (HTMLElement & { create?: (message: string, options?: Record<string, unknown>) => unknown })
      | null;
    if (host?.create) host.create(message, options);
  }

  /** writeText rejects when denied or insecure: toast, never throw. */
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

  /** The ANSI transcript (colours and cursor state preserved, so it replays
   *  in `less -R`), named after the attached session. */
  private downloadTranscript(): void {
    const content = this.serializeXtermAddon ? this.serializeXtermAddon.serialize() : '';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.attachedTarget ?? 'terminal'}-transcript.ans`;
    link.click();
    // The URL can't be revoked before the browser takes it.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    this.terminal?.focus();
  }

  private findQuery(): string {
    return this.findInput?.value ?? '';
  }

  /** Reopens with the saved query selected, so typing replaces it. */
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
    if (native) native.select();
    if (saved) this.runFind(saved, false);
  }

  /** Hands focus back to the terminal; the query stays saved. */
  private closeFind(): void {
    if (this.findDebounce !== null) {
      clearTimeout(this.findDebounce);
      this.findDebounce = null;
    }
    this.searchAddon?.clearDecorations();
    this.findBar?.classList.add('hidden');
    this.terminal?.focus();
  }

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
    // The addon keeps its own result cursor, so repeated Enter steps through matches.
    if (backwards) addon.findPrevious(query, { decorations: resolveFindDecorations() });
    else addon.findNext(query, { decorations: resolveFindDecorations() });
  }

  refreshColorMode(): void {
    if (this.terminal) this.terminal.options.theme = resolveXtermTheme();
    if (this.findBar && !this.findBar.classList.contains('hidden')) this.rerunOpenFind();
  }

  /** Repaint the open find bar's highlights in the new mode's colours. */
  private rerunOpenFind(): void {
    this.runFind(this.findQuery(), false);
  }

  attach(mode: 'terminal' | 'run', target: TerminalId | TmuxSessionName, key: ActiveKey): void {
    this.cancelReconnect();
    this.closeSocket();
    this.terminal?.reset();
    this.bufferPrimed = false;
    this.terminal?.focus();
    this.activeKey = key;
    this.attachedTarget = null;
    this.terminalId = mode === 'terminal' ? (target as TerminalId) : null;
    // The toolbar is built before the mode is known; reveal pop-out here.
    this.toolbar
      ?.querySelector('.tb-pop-out')
      ?.classList.toggle('hidden', this.terminalId === null);
    this.ended = true;
    const msg: ClientMsg =
      mode === 'run' ? { type: 'attach', mode, target } : { type: 'attach', mode, id: target };
    this.attachMsg = msg;
    this.connect(msg, target, key);
  }

  /** Open a socket and send one attach. A close the server didn't announce
   *  (no 'exit' / 'error' first) after a successful attach reconnects. */
  private connect(msg: ClientMsg, label: string, key: ActiveKey): void {
    this.status(`connecting: ${label} …`, 'busy');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const websocket = new WebSocket(`${proto}//${location.host}${BASE}/ws`);
    this.websocket = websocket;
    let ended = false; // the server ended this attach: don't reconnect
    let restarting = false; // the server is shutting down: do reconnect

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
      // Backfill: history captured before the first 'output'. Only into a
      // fresh buffer (a reconnect keeps its own). The history stops above
      // the visible screen, and rows-1 newlines push the viewport down so
      // tmux's home-positioned attach redraw lands below it, not over it.
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
      // Token dropped (logout): final.
      else if (m.type === 'signed-out') {
        ended = true;
        this.ended = true;
        this.status('signed out', 'info');
        this.terminal?.write('\r\nsigned out\r\n');
      }
      // Server shutting down: reconnect with backoff. On a container
      // install tmux dies too, so the reattach then fails as ended.
      else if (m.type === 'restart') {
        restarting = true;
        this.status('server restarting — reconnecting …', 'busy');
      }
    };

    websocket.onclose = () => {
      if (this.websocket !== websocket) return; // superseded
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
      // The console re-polls state on every close, which also sends an
      // expired login back to sign-in.
      this.dispatchEvent(
        new CustomEvent('terminal-closed', { detail: key, bubbles: true, composed: true }),
      );
    };
  }

  /** Tear-down, not a drop: no reconnect. */
  destroy(): void {
    this.cancelReconnect();
    this.closeSocket();
  }

  private closeSocket(): void {
    const ws = this.websocket;
    this.websocket = undefined; // so its onclose sees it was superseded
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

  /** xterm keeps its scrollback (no reset); tmux redraws the screen. */
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

  /** Refit and re-send the size (tmux only learns a size through a client,
   *  so the pty kept its pre-hide dims), focus, and load WebGL once. */
  activate(): void {
    this.ensureWebgl();
    this.fitNow();
    this.sendSize();
    this.terminal?.focus();
  }

  /** Big win for TUI redraws, but browsers cap live contexts (~8–16; past
   *  that the oldest is lost and its terminal corrupts), so only for tabs
   *  that have been on screen. On context loss it's disposed and xterm
   *  falls back to its DOM renderer. */
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
