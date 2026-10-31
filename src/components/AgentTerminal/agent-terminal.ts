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
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
// The protocol types come from the kit's terminal-protocol (one definition,
// shared with the app pages' lean agent-console client — the convergence
// path noted there).
import type { ActiveKey, ClientMsg, ServerMsg } from '@cybermole/app-kit';
import { parseBackfillMsg } from '@cybermole/app-kit';
import type { TerminalId, TmuxSessionName } from '@cybermole/app-kit';
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
/** Tooltip ids must be unique per page; panes are clones of one skeleton. */
let paneSeq = 0;
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

/** xterm and its search addon paint literal colours onto a canvas, so a
 *  Web Awesome token's computed value (var()s already substituted: hex,
 *  named or color-mix) is normalised to rgb() through a 1px offscreen canvas.
 *  undefined when it doesn't resolve, so xterm keeps its default. */
let swatch: OffscreenCanvasRenderingContext2D | null | undefined;
function waColor(token: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (value === '') return undefined;
  swatch ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  if (!swatch) return value;
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = 'transparent';
  swatch.fillStyle = value; // an unparsable value leaves it transparent
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = swatch.getImageData(0, 0, 1, 1).data;
  if (a === 0) return undefined;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** Find highlights use the warning (yellow) fills, like a browser's find.
 *  Cached per mode. */
let findDecorations: ISearchDecorationOptions | null | undefined;
let findDecorationsMode: string | null = null;
function resolveFindDecorations(): ISearchDecorationOptions | undefined {
  const mode = currentColorMode();
  if (findDecorations === undefined || findDecorationsMode !== mode) {
    const match = waColor('--wa-color-warning-fill-normal');
    const active = waColor('--wa-color-warning-fill-loud');
    findDecorations =
      match !== undefined && active !== undefined
        ? {
            matchBackground: match,
            activeMatchBackground: active,
            matchOverviewRuler: match,
            activeMatchColorOverviewRuler: active,
          }
        : null;
    findDecorationsMode = mode;
  }
  return findDecorations ?? undefined;
}

/** Ctrl+F belongs to a focused text field, not the terminal. Probes shadow
 *  roots, since focus can sit on a wa-input host. Anything inside an
 *  <agent-terminal> (xterm's helper textarea, the find input) doesn't count. */
export const inTextField = (el: Element | null): boolean => {
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
    if (!(t as unknown as HTMLElement).checkVisibility()) continue;
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

/** The page's own Web Awesome theme: surface and text tokens for the
 *  canvas, and the palette's hues for the 16 ANSI colours — lighter steps
 *  in dark mode, darker in light, so each reads against the surface. */
function resolveXtermTheme(): ITheme {
  const dark = currentColorMode() === 'wa-dark';
  const hue = (name: string, bright = false): string | undefined =>
    waColor(`--wa-color-${name}-${dark ? (bright ? 80 : 70) : bright ? 50 : 40}`);
  return {
    background: waColor('--wa-color-surface-default'),
    foreground: waColor('--wa-color-text-normal'),
    cursor: waColor('--wa-color-text-normal'),
    cursorAccent: waColor('--wa-color-surface-default'),
    selectionBackground: waColor('--wa-color-brand-fill-normal'),
    black: waColor(dark ? '--wa-color-gray-20' : '--wa-color-gray-10'),
    red: hue('red'),
    green: hue('green'),
    yellow: hue('yellow'),
    blue: hue('blue'),
    magenta: hue('purple'),
    cyan: hue('cyan'),
    white: waColor(dark ? '--wa-color-gray-80' : '--wa-color-gray-70'),
    brightBlack: waColor('--wa-color-gray-40'),
    brightRed: hue('red', true),
    brightGreen: hue('green', true),
    brightYellow: hue('yellow', true),
    brightBlue: hue('blue', true),
    brightMagenta: hue('purple', true),
    brightCyan: hue('cyan', true),
    brightWhite: waColor(dark ? '--wa-color-gray-95' : '--wa-color-gray-90'),
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
    this.wireToolbar();
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

    this.armTouchScroll(terminalContainer);

    this.fitNow();
    // WebGL loads in activate(), not here.
  }

  disconnectedCallback(): void {
    instances.delete(this);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.cancelTouchMomentum();
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

  // ---- touch scrollback ----

  /** A drag must travel this far (px) before it becomes a scroll, so taps
   *  and xterm's own selection gestures keep working. */
  private static readonly TOUCH_CLAIM_PX = 10;
  /** Momentum decay per 16ms frame; below this speed (px/ms) it stops. */
  private static readonly MOMENTUM_DECAY = 0.95;
  private static readonly MOMENTUM_MIN = 0.02;

  /** Fractional rows carried between moves (scrollLines takes integers). */
  private touchRowAccum = 0;
  private touchMomentum: number | null = null;
  private touchMomentumRaf = 0;

  /** px→rows through the container's own box: client height / rows is the
   *  cell height, whatever the renderer drew it with. Positive px (finger
   *  moving down) scrolls back in history. */
  private touchScrollBy(px: number): void {
    const t = this.terminal;
    const cont = this.querySelector('.terminal-container') as HTMLElement | null;
    if (!t || !cont || t.rows <= 0 || cont.clientHeight === 0) return;
    this.touchRowAccum += px / (cont.clientHeight / t.rows);
    const rows = Math.trunc(this.touchRowAccum);
    if (rows !== 0) {
      t.scrollLines(-rows);
      this.touchRowAccum -= rows;
    }
  }

  /** Touch drag scrolls the pane's scrollback — xterm has no touch
   *  scrolling of its own (its touch handlers only feed selection
   *  gestures), and phones have no wheel. Direct 1:1 drag while the finger
   *  is down (terminal.scrollLines — the viewport's DOM scroll area is not
   *  the buffer in this xterm), then a short momentum glide; a new touch
   *  cancels it. */
  private armTouchScroll(container: HTMLElement): void {
    let startY = 0;
    let startX = 0;
    let claimed = false;
    let dead = false; // an x-dominant drag never scrolls
    let lastY = 0;
    let lastT = 0;
    let velocity = 0; // px/ms, positive = finger moving down

    container.addEventListener(
      'touchstart',
      e => {
        this.cancelTouchMomentum();
        this.touchRowAccum = 0;
        claimed = false;
        dead = e.touches.length !== 1;
        const t = e.touches[0];
        if (!t) return;
        startY = lastY = t.clientY;
        startX = t.clientX;
        lastT = performance.now();
        velocity = 0;
      },
      { passive: true },
    );
    container.addEventListener(
      'touchmove',
      e => {
        const t = e.touches[0];
        if (!t || dead || e.touches.length !== 1) {
          if (e.touches.length !== 1) dead = true;
          return;
        }
        const dy = t.clientY - startY;
        if (!claimed) {
          if (Math.abs(dy) < AgentTerminal.TOUCH_CLAIM_PX) return;
          // A sideways-dominant drag is not a scroll; let it go entirely.
          if (Math.abs(t.clientX - startX) > Math.abs(dy)) {
            dead = true;
            return;
          }
          claimed = true;
        }
        e.preventDefault();
        this.touchScrollBy(t.clientY - lastY);
        const now = performance.now();
        const dt = now - lastT;
        if (dt > 0) velocity = (t.clientY - lastY) / dt;
        lastY = t.clientY;
        lastT = now;
      },
      { passive: false },
    );
    container.addEventListener('touchend', () => {
      if (!claimed) return;
      this.touchMomentum = velocity;
      this.glideTouchMomentum();
    });
    container.addEventListener('touchcancel', () => {
      claimed = false;
      this.cancelTouchMomentum();
    });
  }

  private glideTouchMomentum(): void {
    const v = this.touchMomentum;
    if (v === null || Math.abs(v) < AgentTerminal.MOMENTUM_MIN) {
      this.touchMomentum = null;
      return;
    }
    const frameStart = performance.now();
    this.touchMomentumRaf = requestAnimationFrame(() => {
      if (this.touchMomentum === null) return; // cancelled mid-glide
      const dt = performance.now() - frameStart;
      this.touchScrollBy(v * dt);
      this.touchMomentum = v * Math.pow(AgentTerminal.MOMENTUM_DECAY, dt / 16);
      this.glideTouchMomentum();
    });
  }

  private cancelTouchMomentum(): void {
    this.touchMomentum = null;
    if (this.touchMomentumRaf !== 0) cancelAnimationFrame(this.touchMomentumRaf);
    this.touchMomentumRaf = 0;
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
    for (const k of ['busy', 'ok', 'err', 'info']) el.classList.toggle(k, k === kind);
    for (const indicator of el.querySelectorAll<HTMLElement>('[data-kind]'))
      indicator.classList.toggle('hidden', indicator.dataset.kind !== kind);
    const label = el.querySelector('.status-text');
    if (label) label.textContent = text;
  }

  // ---- toolbar ----

  /** The toolbar is AgentTerminal.astro's markup, absolutely positioned so
   *  the ResizeObserver still sees the container's true box. Wired once. */
  private wireToolbar(): void {
    const bar = this.querySelector<HTMLElement>('.terminal-toolbar');
    if (!bar || this.toolbar === bar) return;
    this.toolbar = bar;
    this.findBar = bar.querySelector<HTMLElement>('.terminal-find');
    const pane = `pane-${++paneSeq}`;
    for (const tip of bar.querySelectorAll<HTMLElement>('wa-tooltip[data-tip]')) {
      const anchor = bar.querySelector(`.${tip.dataset.tip}`);
      if (!anchor) continue;
      anchor.id = `${pane}-${tip.dataset.tip}`;
      tip.setAttribute('for', anchor.id);
    }
    // The move itself belongs to <terminal-tabs>, which catches the bubbled event.
    bar.querySelector('.tb-pop-out')?.addEventListener('click', () => {
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
    bar.querySelector('.tb-copy-output')?.addEventListener('click', () => void this.copyOutput());
    bar
      .querySelector('.tb-download-transcript')
      ?.addEventListener('click', () => this.downloadTranscript());
    // A phone's soft keyboard has no esc, and TUIs need it (closing
    // dialogs, backing out of screens). One byte, then back to the pane.
    // CSS keeps the button to narrow viewports — a hardware key renders
    // it redundant.
    // Focus FIRST, send after: clicking blurs the terminal (xterm emits a
    // focus-out), and refocusing emits a focus-in — a byte sent between
    // the two glues onto the focus-in sequence (tmux reads ESC+[I as one
    // key) and never reaches the pane as ESC. After the focus-in, the
    // byte travels alone.
    bar.querySelector('.tb-esc')?.addEventListener('click', () => {
      this.terminal?.focus();
      this.send({ type: 'input', data: '\u001b' });
    });
    const input = bar.querySelector('.terminal-find-input') as
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
    bar
      .querySelector('.find-next')
      ?.addEventListener('click', () => this.runFind(this.findQuery(), false));
    bar
      .querySelector('.find-prev')
      ?.addEventListener('click', () => this.runFind(this.findQuery(), true));
    bar.querySelector('.find-close')?.addEventListener('click', () => this.closeFind());
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
    const link = this.querySelector<HTMLAnchorElement>('.tb-download-link');
    if (!link) return;
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
    // The toolbar is wired before the mode is known; reveal pop-out here.
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
