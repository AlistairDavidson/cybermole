// console-app.ts — <console-app>: orchestrates sidebar ↔ terminal on a
// <wa-page> app shell (sidebar + free mobile drawer), state polling,
// logout, hide/unhide dialogs, toasts. Shell markup is SSR'd by
// ConsoleApp.astro; this module registers <console-app> client-side and
// drives it. Dialogs live here (outside the sidebar's innerHTML poll):
// the sidebar only emits hide-session / manage-hidden and stays stateless.
import type { ActiveKey, ConsoleState, PastSession } from '../../lib/types';
import { asPiSessionId, asTmuxSessionName, type PiSessionId, type TmuxSessionName } from '../../types/branded';
import { TMUX_SESSION_NAME_RE } from '../../schemas/patterns';
import { BASE } from '../../base';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '../AgentTerminal/agent-terminal';
import '../session-sidebar';
import { esc } from '../html';

/** Minimal typing for <wa-toast>.create(). */
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

/** Minimal typing for <wa-dialog>. */
type WaDialog = HTMLElement & { show(): void; open: boolean };

export class ConsoleApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeKey: ActiveKey | null = null;
  /** Deep-link target (/?live=<session>) — attached on the first state
   *  load that sees the session alive (e.g. "view run" from /jobs). */
  private pendingLive: TmuxSessionName | null = (() => {
    const v = new URLSearchParams(location.search).get('live') ?? '';
    return TMUX_SESSION_NAME_RE.test(v) ? asTmuxSessionName(v) : null;
  })();
  private state: ConsoleState | null = null;
  private pendingHide: { id: PiSessionId; title: string } | null = null;

  connectedCallback(): void {
    const term = this.querySelector('agent-terminal') as
      import('../AgentTerminal/agent-terminal').AgentTerminal & HTMLElement;

    // Event details round-trip through the sidebar's markup, which was
    // rendered from server state — a trusted source for these ids.
    this.addEventListener('attach-live', e => {
      const name = asTmuxSessionName((e as CustomEvent<string>).detail);
      this.activeKey = `live:${name}`;
      term.attach('live', name, this.activeKey);
      this.loadState();
    });
    this.addEventListener('attach-resume', e => {
      const id = asPiSessionId((e as CustomEvent<string>).detail);
      this.activeKey = `resume:${id}`;
      term.attach('resume', id, this.activeKey);
    });
    this.addEventListener('new-session', async e => {
      const name = (e as CustomEvent<string>).detail;
      const sent = await signedInFetch(`${BASE}/api/new`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!sent.ok) { this.notAnswered(sent); return; }
      const r = sent.data.response;
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'could not create session' }));
        const msg = (err as { error?: string }).error ?? 'could not create session';
        this.toast(msg, { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
        return;
      }
      const out = await r.json() as { name: TmuxSessionName };
      this.activeKey = `live:${out.name}`;
      await this.loadState();
      term.attach('live', out.name, this.activeKey);
    });
    this.addEventListener('terminal-closed', () => this.loadState());
    (this.querySelector('#nav-jobs') as HTMLElement).onclick = () => {
      location.href = `${BASE}/jobs`;
    };

    // "Open in Zed" (docs/zed-webapp.md): open the stream tab synchronously
    // inside the click's task (an await first would eat the user activation
    // and the popup blocker would eat the tab), then ask the server to make
    // the folder appear in it — the launcher boots Zed if it isn't running.
    this.addEventListener('open-zed', e => {
      const { cwd } = (e as CustomEvent<{ cwd: string }>).detail;
      const url = this.state?.zed?.url;
      if (!url) return; // feature off — the sidebar never renders the button
      window.open(url, '_blank', 'noopener');
      void this.launchZed(cwd);
    });

    // Sidebar hide/manage affordances → the dialogs owned here.
    this.addEventListener('hide-session', e => {
      const detail = (e as CustomEvent<{ id: string; title: string }>).detail;
      this.pendingHide = { id: asPiSessionId(detail.id), title: detail.title };
      (this.querySelector('#confirm-hide-title') as HTMLElement).textContent =
        `“${this.pendingHide.title}”`;
      this.dialog('#confirm-hide').show();
    });
    this.addEventListener('manage-hidden', () => {
      this.renderHiddenList();
      this.dialog('#hidden-dialog').show();
    });
    (this.querySelector('#confirm-hide-ok') as HTMLElement).onclick = () => void this.confirmHide();
    (this.querySelector('#unhide-all') as HTMLElement).onclick = () => void this.unhideAll();
    (this.querySelector('#logout') as HTMLElement).onclick = async () => {
      const sent = await signedInFetch(`${BASE}/logout`, { method: 'POST' });
      if (!sent.ok) { this.notAnswered(sent); return; }
      location.href = `${BASE}/login`;
    };

    this.loadState();
    this.pollTimer = setInterval(() => this.loadState(), 15000);
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private dialog(sel: string): WaDialog {
    return this.querySelector(sel) as WaDialog;
  }

  private toast(message: string, options?: Record<string, unknown>): void {
    (this.querySelector('wa-toast') as WaToast | null)?.create(message, options);
  }

  /** A request that got no answer. Signed out needs no toast: the page is
   *  already on its way to /login. */
  private notAnswered(failure: SignedInFetchFailure): void {
    switch (failure.errorCode) {
      case 'signed_out': return;
      case 'network_error':
        this.toast('network error — try again', { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
        return;
      default: return failure satisfies never;
    }
  }

  /** POST JSON; toasts on failure. False → caller keeps its UI as-is. */
  private async post(path: string, body: Record<string, unknown>): Promise<boolean> {
    const sent = await signedInFetch(`${BASE}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!sent.ok) { this.notAnswered(sent); return false; }
    const r = sent.data.response;
    if (!r.ok) {
      this.toast('could not save — try again', { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
      return false;
    }
    return true;
  }

  private async confirmHide(): Promise<void> {
    const pending = this.pendingHide;
    if (!pending) return;
    const ok = await this.post('/api/session/hide', { id: pending.id });
    this.pendingHide = null;
    this.dialog('#confirm-hide').open = false;
    if (!ok) return;
    await this.loadState();
    this.toast('hidden from the list — undo via “hidden — manage”', { variant: 'neutral', icon: 'eye-slash', duration: 6000 });
  }

  private async unhide(id: PiSessionId): Promise<void> {
    if (await this.post('/api/session/unhide', { id })) {
      await this.loadState();          // refreshes sidebar + this dialog
      this.renderHiddenList();
    }
  }

  private async unhideAll(): Promise<void> {
    if (await this.post('/api/session/unhide', { all: true })) {
      await this.loadState();
      this.renderHiddenList();
    }
  }

  /** POST the folder-open; toasts on failure (the tab is already open —
   *  a failure here means the folder didn't appear, not that the stream
   *  is broken). */
  private async launchZed(cwd: string): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/zed/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: cwd }),
    });
    if (!sent.ok) { this.notAnswered(sent); return; }
    const r = sent.data.response;
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'could not open in Zed' })) as { error?: string };
      this.toast(err.error ?? 'could not open in Zed', { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
      return;
    }
    this.toast(`opening ${cwd} in Zed`, { variant: 'neutral', icon: 'code', duration: 3000 });
  }

  /** Body of the manage-hidden dialog: hidden sessions from the last
   *  state poll (the dialog itself is static, so polls only swap this). */
  private renderHiddenList(): void {
    const body = this.querySelector('#hidden-list') as HTMLElement | null;
    if (!body) return;
    const hidden = (this.state?.sessions ?? []).filter(s => s.hidden);
    const older = (this.state?.hiddenCount ?? 0) - hidden.length;
    body.innerHTML = hidden.length
      ? hidden.map(s => this.hiddenRow(s)).join('')
        + (older > 0 ? `<p class="dialog-note">… and ${older} older hidden session${older === 1 ? '' : 's'} ` +
          `(beyond the newest cap) — “unhide all” restores those too.</p>` : '')
      : '<p class="dialog-note">No hidden sessions.</p>';
    body.querySelectorAll<HTMLElement>('[data-unhide]').forEach(btn => {
      btn.onclick = () => void this.unhide(asPiSessionId(btn.dataset.unhide!));
    });
    (this.querySelector('#unhide-all') as HTMLElement).toggleAttribute('disabled', hidden.length === 0);
  }

  private hiddenRow(s: PastSession): string {
    return `<div class="hidden-row">` +
      `<span class="hidden-meta">` +
      `<span class="t-name" title="${esc(s.id)}">${esc(s.title)}</span>` +
      `<span class="d">${esc(s.cwd)} · ` +
      `<wa-relative-time date="${new Date(s.mtime).toISOString()}" format="narrow" sync></wa-relative-time>` +
      `</span></span>` +
      `<wa-button data-unhide="${esc(s.id)}" size="s" appearance="accent" variant="neutral" ` +
      `title="show this session in the list again">` +
      `<wa-icon slot="start" name="eye"></wa-icon>unhide</wa-button></div>`;
  }

  async loadState(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/state`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (!r.ok) return;
    const st = await r.json() as ConsoleState;
    this.state = st;
    const sidebar = this.querySelector('session-sidebar');
    if (sidebar) (sidebar as import('../session-sidebar').SessionSidebar).render(st, this.activeKey);
    if (this.pendingLive) {
      const target = this.pendingLive;
      if (st.live.some(s => s.name === target)) {
        this.pendingLive = null;
        this.activeKey = `live:${target}`;
        const term = this.querySelector('agent-terminal') as
          (import('../AgentTerminal/agent-terminal').AgentTerminal & HTMLElement) | null;
        term?.attach('live', target, this.activeKey);
        (sidebar as import('../session-sidebar').SessionSidebar | null)
          ?.render(st, this.activeKey);
      }
    }

    const dlg = this.dialog('#hidden-dialog');
    if (dlg.open) this.renderHiddenList(); // keep an open manage dialog fresh
  }
}

if (!customElements.get('console-app')) customElements.define('console-app', ConsoleApp);
