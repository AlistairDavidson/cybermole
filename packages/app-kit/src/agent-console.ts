// <agent-console>: the agent drawer every app page embeds — one
// implementation in app-kit, so every app gets the same console. The page
// passes its slug (`<agent-console slug="notes">` — the scaffold template
// substitutes __APP_SLUG__), and the element does the rest client-side:
//
//   affordance (fixed, end-bottom)  →  wa-drawer (end placement, full
//   width on phones)  →  ONE lean xterm over the console's /ws bridge.
//
// The open flow resolves this app's OPERATOR workspace (app_id = this app,
// kind NULL — cwd in the app tree), creating it through POST /api/workspaces
// {appId} on first open, then attaches to its agent terminal. Same-origin
// /api + /ws from an app page carry the session cookie and pass the main
// gate (apps-plan trust model: one uid, scope by framing, not sandboxing).
// A dead session respawns at the workspace cwd server-side; closing the
// drawer detaches (the tmux session keeps running), reopening re-attaches
// with fresh backfill. Failures render in the drawer's status line, never
// on the page.
//
// This is the LEAN client, deliberately: the console's rich
// <agent-terminal> (find bar, toolbar, WebGL, transcripts) keeps its own
// implementation; both consume the one protocol definition in
// ./terminal-protocol. Convergence path: factor agent-terminal.ts onto
// this attach/reconnect core once the drawer grows features the console
// lacks, not before.
import './wa-client';
import '@awesome.me/webawesome/dist/styles/themes/default.css';
import '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './agent-console.css';
import type { ClientMsg, ServerMsg } from './terminal-protocol';
import { parseBackfillMsg } from './terminal-protocol';
import {
  appBySlug,
  builderLink,
  firstTerminal,
  operatorWorkspace,
  type ConsoleStateLite,
} from './agent-console-flow';
import type { AppId, TerminalId } from './types/branded';

/** The app is mounted at /apps/<slug>/… on the console origin, so the
 *  console's base — root of /api, /ws and /builder — is the pathname's
 *  prefix. Read from the document (not import.meta) so the module checks
 *  under the kit's CommonJS-oriented tsconfig too. */
function consoleBase(): string {
  const i = location.pathname.indexOf('/apps/');
  return i <= 0 ? '' : location.pathname.slice(0, i);
}

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

/** The xterm theme from page tokens: keys that don't resolve (no token
 *  layer) fall back to xterm's defaults. ANSI 16 stay xterm's defaults —
 *  programs own those. */
function tokenTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string): string | undefined => {
    const value = cs.getPropertyValue(name).trim();
    return value === '' ? undefined : value;
  };
  const background = pick('--wa-color-surface-lowered');
  const foreground = pick('--wa-color-text-normal');
  const cursor = pick('--wa-color-text-normal');
  const cursorAccent = pick('--wa-color-surface-lowered');
  const selectionBackground = pick('--wa-color-overlay-inline');
  return {
    ...(background !== undefined ? { background } : {}),
    ...(foreground !== undefined ? { foreground } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(cursorAccent !== undefined ? { cursorAccent } : {}),
    ...(selectionBackground !== undefined ? { selectionBackground } : {}),
  };
}

/** One JSON Result off the console's API, or an error message. */
async function apiJson(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; json: unknown } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    return { ok: false, message: `could not reach the console (${(e as Error).message})` };
  }
  if (response.status === 401)
    return { ok: false, message: 'signed out — sign in at the console, then come back' };
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* error bodies below carry no JSON */
  }
  if (!response.ok) {
    const failure = json as { errorMessage?: string; errorCode?: string } | null;
    const detail = failure?.errorMessage ?? failure?.errorCode ?? `HTTP ${response.status}`;
    return { ok: false, message: detail };
  }
  return { ok: true, json };
}

export class AgentConsole extends HTMLElement {
  /** The lean terminal's xterm, for tests reading the pane. */
  terminal?: Terminal;
  private drawer: (HTMLElement & { open: boolean }) | null = null;
  private statusEl: HTMLElement | null = null;
  private builderAnchor: HTMLAnchorElement | null = null;
  private container: HTMLElement | null = null;
  private readonly slug: string = '';
  /** The console's base ('' or '/foo'), resolved once per connect. */
  private base = '';
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private websocket: WebSocket | null = null;
  private attachMsg: ClientMsg | null = null;
  /** The attached tmux session (set only by an 'attached' frame: a socket
   *  that never attached reconnects nothing). */
  private attachedTarget = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private bufferPrimed = false;
  /** Guards the open flow: a second open while one resolves reuses it. */
  private opening: Promise<void> | null = null;

  constructor() {
    super();
    const raw = this.getAttribute('slug') ?? '';
    this.slug = raw.trim();
  }

  connectedCallback(): void {
    if (this.childElementCount > 0 || this.slug === '') return;
    this.base = consoleBase();
    this.render();
    void this.refreshBuilderLink();
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.detach();
  }

  private render(): void {
    const cluster = document.createElement('div');
    cluster.className = 'agent-console-affordance';
    this.builderAnchor = document.createElement('a');
    this.builderAnchor.className = 'agent-console-builder';
    this.builderAnchor.href = `${this.base}/builder`;
    this.builderAnchor.textContent = 'builder';
    this.builderAnchor.title = 'this app\u2019s build sessions on the builder page';
    const open = document.createElement('wa-button') as HTMLElement & {
      pill: boolean;
      variant: string;
    };
    open.className = 'agent-console-open';
    open.pill = true;
    open.variant = 'brand';
    open.setAttribute('aria-label', `open this app\u2019s agent drawer`);
    open.innerHTML = '<wa-icon slot="start" name="terminal" label="agent"></wa-icon>agent';
    open.addEventListener('click', () => void this.open());
    cluster.append(this.builderAnchor, open);

    const drawer = document.createElement('wa-drawer') as HTMLElement & { open: boolean };
    drawer.className = 'agent-console-drawer';
    drawer.setAttribute('label', `agent \u2014 ${this.slug}`);
    drawer.setAttribute('placement', 'end');
    drawer.addEventListener('wa-hide', () => this.detach());
    drawer.addEventListener('wa-after-show', () => this.fitNow(true));
    const pane = document.createElement('div');
    pane.className = 'agent-console-pane';
    this.container = document.createElement('div');
    this.container.className = 'terminal-container';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'terminal-status';
    pane.append(this.container, this.statusEl);
    drawer.appendChild(pane);
    this.drawer = drawer;

    this.append(cluster, drawer);
    this.mountTerminal();
  }

  private mountTerminal(): void {
    if (!this.container) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'monospace',
      scrollback: 5000,
      theme: tokenTheme(),
    });
    this.fitAddon = new FitAddon();
    terminal.loadAddon(this.fitAddon);
    terminal.open(this.container);
    terminal.onData(d => {
      for (const data of chunkInput(d)) this.send({ type: 'input', data });
    });
    terminal.onResize(() => this.sendSize());
    this.terminal = terminal;

    this.resizeObserver = new ResizeObserver(() => this.fitNow(false));
    this.resizeObserver.observe(this.container);
  }

  // ---- open flow ----

  private async open(): Promise<void> {
    if (this.drawer) this.drawer.open = true;
    if (this.opening) return;
    this.opening = this.ensureAttached().finally(() => {
      this.opening = null;
    });
    await this.opening;
  }

  /** Resolve (or create) the operator workspace, then attach. Errors land
   *  in the status line; the page is never touched. */
  private async ensureAttached(): Promise<void> {
    this.status('resolving this app\u2019s workspace \u2026');
    const state = await this.fetchState();
    if (!state.ok) return this.status(state.message, 'err');
    const app = appBySlug(state.state, this.slug);
    if (!app)
      return this.status(
        `no app row for slug "${this.slug}" — register it from the console first`,
        'err',
      );
    this.updateBuilderLink(state.state, app.id);

    let stateForPick = state.state;
    let workspaceId = operatorWorkspace(stateForPick, app.id);
    if (workspaceId === null) {
      this.status('creating the operator workspace \u2026');
      const created = await apiJson(`${this.base}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: app.id }),
      });
      if (!created.ok) return this.status(created.message, 'err');
      const fresh = await this.fetchState();
      if (!fresh.ok) return this.status(fresh.message, 'err');
      stateForPick = fresh.state;
      workspaceId = operatorWorkspace(stateForPick, app.id);
      if (workspaceId === null)
        return this.status('the workspace was created but does not appear in state', 'err');
    }

    let terminalId = firstTerminal(stateForPick, workspaceId);
    if (terminalId === null) {
      this.status('opening the agent tab \u2026');
      const opened = await apiJson(`${this.base}/api/workspaces/${workspaceId}/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'agent' }),
      });
      if (!opened.ok) return this.status(opened.message, 'err');
      // The route answers the row flat (NewTerminalData), not enveloped.
      const row = opened.json as { id?: string };
      if (!row.id) return this.status('the agent tab was created but carries no id', 'err');
      terminalId = row.id as TerminalId;
    }
    this.attach(terminalId);
  }

  private async fetchState(): Promise<
    { ok: true; state: ConsoleStateLite } | { ok: false; message: string }
  > {
    const r = await apiJson(`${this.base}/api/state`);
    return r.ok
      ? { ok: true, state: r.json as ConsoleStateLite }
      : { ok: false, message: r.message };
  }

  /** The affordance's builder deep link, from a fresh state read. */
  private async refreshBuilderLink(): Promise<void> {
    const state = await this.fetchState();
    if (!state.ok) return; // plain /builder stays the safe default
    const app = appBySlug(state.state, this.slug);
    if (app) this.updateBuilderLink(state.state, app.id);
  }

  private updateBuilderLink(state: ConsoleStateLite, appId: AppId): void {
    if (this.builderAnchor) this.builderAnchor.href = builderLink(state, appId, this.base);
  }

  // ---- the lean attach ----

  private attach(id: TerminalId): void {
    this.cancelReconnect();
    this.closeSocket();
    this.terminal?.reset();
    this.bufferPrimed = false;
    this.attachedTarget = '';
    this.terminal?.focus();
    const msg: ClientMsg = { type: 'attach', mode: 'terminal', id };
    this.attachMsg = msg;
    this.connect(msg, id);
  }

  private connect(msg: ClientMsg, label: string): void {
    this.status(`connecting: ${label} \u2026`);

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const websocket = new WebSocket(`${proto}//${location.host}${this.base}/ws`);
    this.websocket = websocket;
    let ended = false; // the server ended this attach: don't reconnect
    let restarting = false; // the server is shutting down: do reconnect

    websocket.onopen = () => {
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
      // fresh buffer (a reconnect keeps its own). Rows-1 newlines push the
      // viewport down so tmux's home-positioned attach redraw lands below
      // the history, not over it.
      else if (m.type === 'backfill') {
        const b = parseBackfillMsg(ev.data as string);
        if (!b || b.data === '' || this.bufferPrimed || !this.terminal) return;
        this.bufferPrimed = true;
        this.terminal.write(b.data);
        if (this.terminal.rows > 1) this.terminal.write('\n'.repeat(this.terminal.rows - 1));
      } else if (m.type === 'attached') {
        this.attachedTarget = m.target;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.status(`attached: ${m.target} (${m.socket} socket)`, 'ok');
      } else if (m.type === 'error') {
        ended = true;
        this.status(m.message, 'err');
        this.terminal?.write(`\r\n\u001b[31m${m.message}\u001b[0m\r\n`);
      } else if (m.type === 'exit') {
        ended = true;
        this.status(`detached: ${m.target}`, 'info');
      } else if (m.type === 'signed-out') {
        ended = true;
        this.status('signed out — sign in at the console, then reopen', 'info');
        this.terminal?.write('\r\nsigned out\r\n');
      } else if (m.type === 'restart') {
        restarting = true;
        this.status('server restarting — reconnecting \u2026');
      }
    };

    websocket.onclose = () => {
      if (this.websocket !== websocket) return; // superseded
      this.websocket = null;
      if (ended) return;
      if (this.attachedTarget !== '') {
        this.scheduleReconnect(restarting ? 'server restarting' : 'disconnected');
      } else {
        this.status(`could not connect: ${label}`, 'err');
      }
    };
  }

  /** Tear-down, not a drop: no reconnect; the tmux session keeps running. */
  detach(): void {
    this.cancelReconnect();
    this.closeSocket();
  }

  private closeSocket(): void {
    const ws = this.websocket;
    this.websocket = null; // so its onclose sees it was superseded
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
    this.status(`${reason} — reconnecting in ${Math.round(delay / 1000)}s \u2026`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect();
    }, delay);
  }

  /** xterm keeps its scrollback (no reset); tmux redraws the screen. */
  private reconnect(): void {
    const msg = this.attachMsg;
    if (!msg || this.attachedTarget === '') return;
    this.connect(msg, this.attachedTarget);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
  }

  // ---- plumbing ----

  private send(msg: ClientMsg): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN)
      this.websocket.send(JSON.stringify(msg));
  }

  private sendSize(): void {
    if (this.terminal)
      this.send({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows });
  }

  /** Refit when the pane has a box; refocus on drawer show. */
  private fitNow(focus: boolean): void {
    const box = this.container;
    if (!box || box.clientWidth === 0 || box.clientHeight === 0) return;
    this.fitAddon?.fit();
    this.sendSize();
    if (focus) this.terminal?.focus();
  }

  private status(text: string, kind: 'busy' | 'ok' | 'err' | 'info' = 'busy'): void {
    const el = this.statusEl;
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
}

if (!customElements.get('agent-console')) customElements.define('agent-console', AgentConsole);
