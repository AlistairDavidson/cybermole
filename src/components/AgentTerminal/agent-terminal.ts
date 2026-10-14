// agent-terminal.ts — <agent-terminal>: xterm.js over websocket to node-pty/tmux.
// Light DOM (xterm injects its own styles; global CSS applies).
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
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type { ActiveKey, ClientMsg, ServerMsg } from '../../lib/types';
import type { PiSessionId, TerminalId, TmuxSessionName } from '../../types/branded';
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

export class AgentTerminal extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['status'];
  }

  terminal?: Terminal;
  fitXtermAddon?: FitAddon;
  websocket?: WebSocket;
  activeKey?: ActiveKey;
  resizeObserver?: ResizeObserver;
  /** tmux session the server last attached us to — set on 'attached'. */
  private attachedTarget: TmuxSessionName | null = null;
  /** The attach frame this element STARTED with (terminal id / run target
   *  / live name / resume id — plan §7): a reconnect re-sends it, so the
   *  attach keeps its mode — a terminal tab whose session died mid-drop
   *  gets the §4 respawn instead of 'no such live session', and a run
   *  attach never morphs into a respawn. Cleared when attach() starts a
   *  new target. */
  private attachMsg: ClientMsg | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  /** Back online / tab visible again: skip the rest of a pending backoff. */
  private readonly reconnectNow = (): void => {
    if (this.reconnectTimer === null || document.visibilityState === 'hidden') return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnect();
  };

  connectedCallback(): void {
    window.addEventListener('online', this.reconnectNow);
    document.addEventListener('visibilitychange', this.reconnectNow);
    if (this.terminal) {
      return;
    }

    const terminalContainer = this.querySelector('.terminal-container') as HTMLElement;

    const surfaceColor = getComputedStyle(this).getPropertyValue('--wa-color-surface-default').trim() || '#11131a';

    this.terminal = new Terminal({
      cursorBlink: true, fontSize: 13, fontFamily: 'monospace',
      scrollback: 5000, theme: {
        background: surfaceColor
      },
    });

    this.fitXtermAddon = new FitAddon();
    this.terminal.loadAddon(this.fitXtermAddon);

    this.terminal.open(terminalContainer);

    // URLs in agent output become clickable (a custom handler — e.g.
    // copy-to-clipboard instead of navigate — can come later).
    this.terminal.loadAddon(new WebLinksAddon());

    this.fitXtermAddon.fit();

    // A paste arrives as one onData call of any size — sent as consecutive
    // frames, which the server writes to the pty in order.
    this.terminal.onData(d => {
      for (const data of chunkInput(d)) this.send({ type: 'input', data });
    });

    this.terminal.onResize(
      () => this.sendSize()
    );

    this.resizeObserver = new ResizeObserver(
      () => this.fitXtermAddon?.fit()
    );
    this.resizeObserver.observe(terminalContainer);

    this.fitXtermAddon.fit();

    // WebGL renderer — the big win for pi's full-screen TUI redraws.
    // Lazy-imported so the chunk never blocks first paint. Disposing the
    // addon (on context loss; or never loading it if WebGL is missing)
    // leaves xterm on its built-in DOM renderer.
    void import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (!this.terminal) return;
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          this.terminal.loadAddon(webgl);
        } catch { /* no WebGL: stay on the DOM renderer */ }
      })
      .catch(() => { /* chunk failed to load: stay on the DOM renderer */ });
  }

  disconnectedCallback(): void {
    window.removeEventListener('online', this.reconnectNow);
    document.removeEventListener('visibilitychange', this.reconnectNow);
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

  private status(text: string, kind: 'busy' | 'ok' | 'err' | 'info' = 'busy'): void {
    const el = this.querySelector('.terminal-status');
    if (!el) return;
    const indicator =
      kind === 'busy' ? '<wa-spinner></wa-spinner>' :
      kind === 'ok' ? '<wa-icon name="circle-check"></wa-icon>' :
      kind === 'err' ? '<wa-icon name="triangle-exclamation"></wa-icon>' :
      '<wa-icon name="circle-info"></wa-icon>';
    el.className = `terminal-status ${kind}`;
    el.innerHTML = `${indicator}<span></span>`;
    (el.lastElementChild as HTMLElement).textContent = text;
  }

  attach(mode: 'live' | 'resume' | 'terminal' | 'run',
    target: TmuxSessionName | PiSessionId | TerminalId, key: ActiveKey): void {
    this.cancelReconnect();
    this.closeSocket();
    this.terminal?.reset();
    this.terminal?.focus();
    this.activeKey = key;
    this.attachedTarget = null;
    // task/ws-terminal (plan §7): the workspace-model modes join live and
    // resume — 'terminal' carries the tab's uuid (the server derives
    // t-<uuid>, respawning if dead), 'run' a live job run's session name
    // (never respawned). The old modes stay until branch 4's UI swap.
    const msg: ClientMsg = mode === 'live' || mode === 'run'
      ? { type: 'attach', mode, target }
      : { type: 'attach', mode, id: target };
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
      websocket.send(JSON.stringify(msg));
      this.sendSize();
    };

    websocket.onmessage = ev => {
      let m: ServerMsg; try { m = JSON.parse(ev.data as string) as ServerMsg; } catch { return; }
      if (m.type === 'output') this.terminal?.write(m.data);
      else if (m.type === 'attached') {
        this.attachedTarget = m.target;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.status(`attached: ${m.target} (${m.socket} socket)`, 'ok');
      }
      else if (m.type === 'error') { ended = true; this.status(m.message, 'err'); this.terminal?.write(`\r\n\u001b[31m${m.message}\u001b[0m\r\n`); }
      else if (m.type === 'exit') { ended = true; this.status(`detached: ${m.target}`, 'info'); }
      // The token this socket used was dropped (logout / log out
      // everywhere): final — like 'exit', never reconnected.
      else if (m.type === 'signed-out') {
        ended = true;
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
        if (this.attachedTarget) this.scheduleReconnect(restarting ? 'server restarting' : 'disconnected');
        else this.status(`could not connect: ${label}`, 'err');
      }
      // The console re-polls state on every close — which also sends an
      // expired login back to the sign-in page instead of retrying forever.
      this.dispatchEvent(new CustomEvent('terminal-closed', { detail: key }));
    };
  }

  private closeSocket(): void {
    const ws = this.websocket;
    this.websocket = undefined; // its onclose now sees it was superseded
    if (ws) { try { ws.close(); } catch { /* already closed */ } }
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
   *  run. Resume is the one exception, unchanged from before the modes:
   *  it reconnects LIVE to the session the resume opened — a resume is
   *  never re-run, so a pi that exited in the meantime ends in
   *  'no such live session', not a fresh pi. */
  private reconnect(): void {
    const target = this.attachedTarget;
    const key = this.activeKey;
    const msg = this.attachMsg;
    if (!target || !key || !msg) return;
    this.connect(msg.type === 'attach' && msg.mode === 'resume'
      ? { type: 'attach', mode: 'live', target }
      : msg, target, key);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
  }

  refit(): void { this.fitXtermAddon?.fit(); }
}

if (!customElements.get('agent-terminal')) customElements.define('agent-terminal', AgentTerminal);
