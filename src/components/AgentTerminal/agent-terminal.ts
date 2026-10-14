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
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import type { ActiveKey, ClientMsg, ServerMsg } from '../../lib/types';
import type { TerminalId, TmuxSessionName } from '../../types/branded';
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

    this.fitNow();

    // A paste arrives as one onData call of any size — sent as consecutive
    // frames, which the server writes to the pty in order.
    this.terminal.onData(d => {
      for (const data of chunkInput(d)) this.send({ type: 'input', data });
    });

    this.terminal.onResize(
      () => this.sendSize()
    );

    this.resizeObserver = new ResizeObserver(
      () => this.fitNow()
    );
    this.resizeObserver.observe(terminalContainer);

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
      kind === 'busy' ? '<wa-spinner></wa-spinner>' :
      kind === 'ok' ? '<wa-icon name="circle-check"></wa-icon>' :
      kind === 'err' ? '<wa-icon name="triangle-exclamation"></wa-icon>' :
      '<wa-icon name="circle-info"></wa-icon>';
    el.className = `terminal-status ${kind}`;
    el.innerHTML = `${indicator}<span></span>`;
    (el.lastElementChild as HTMLElement).textContent = text;
  }

  attach(mode: 'terminal' | 'run',
    target: TerminalId | TmuxSessionName, key: ActiveKey): void {
    this.cancelReconnect();
    this.closeSocket();
    this.terminal?.reset();
    this.terminal?.focus();
    this.activeKey = key;
    this.attachedTarget = null;
    // 'terminal' carries the tab's uuid (the server derives t-<uuid>,
    // respawning if dead — plan §4); 'run' a live job run's session name
    // (never respawned).
    const msg: ClientMsg = mode === 'run'
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
      this.dispatchEvent(new CustomEvent('terminal-closed', { detail: key, bubbles: true, composed: true }));
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
        } catch { /* no WebGL: stay on the DOM renderer */ }
      })
      .catch(() => { /* chunk failed to load: stay on the DOM renderer */ });
  }
}

if (!customElements.get('agent-terminal')) customElements.define('agent-terminal', AgentTerminal);
