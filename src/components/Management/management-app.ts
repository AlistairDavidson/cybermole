// management-app.ts — <management-app>: enhances the server-rendered
// /management page (ManagementView.astro). Data arrives as HTML (the
// page + /partials/management with the picked sha as ?sha=); this element
// wires the verbs — pick a commit, request a build, activate a release /
// roll back — each through the confirm dialog (password re-verification:
// a live cookie alone cannot swap the server, docs/management-page.md
// §1.6), then refreshes the [data-refresh] regions and, after an
// activation, waits out the server's restart and reloads. The verdicts
// shown are the SERVER's; nothing here decides what is allowed.
import { BASE } from '../../base';
import { parseServerHTML } from '../html';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
// Registers <validation-enhancer-zod> (and the base <validation-enhancer>).
import 'validation-enhancer/zod';
import type { ValidationEnhancerZod } from 'validation-enhancer/zod';
import { ManagementConfirmFormSchema } from '../../schemas/management';

type WaDialog = HTMLElement & { open: boolean };
type WaCheckbox = HTMLElement & { checked: boolean };
type WaCallout = HTMLElement & { variant: string };
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};
/** wa-input surface (an empty wa-input's value is null, not ''). */
type WaInput = HTMLElement & { value: string | null; setCustomValidity(m: string): void };

/** What the confirm dialog will do once the password checks out. */
type Pending =
  | { kind: 'build'; sha: string }
  | { kind: 'activate'; target: 'image' | string };

const POLL_FAST_MS = 5_000;   // while a build is pending/running
const POLL_SLOW_MS = 20_000;
const RESTART_WAIT_MS = 90_000;

export class ManagementApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pending: Pending | null = null;
  private inflight = false;

  private $<T extends HTMLElement>(id: string): T {
    return this.querySelector(`#${id}`) as T;
  }

  connectedCallback(): void {
    this.addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-pick], [data-build], [data-activate]');
      if (!el) return;
      const pick = el.dataset.pick, build = el.dataset.build, activate = el.dataset.activate;
      if (pick) void this.pick(pick);
      else if (build) this.confirm({ kind: 'build', sha: build });
      else if (activate !== undefined) this.confirm({ kind: 'activate', target: activate });
    });
    // The footer button lives outside the form (dialog footer slot), and
    // validation runs first: the submit listener sits ABOVE the enhancer,
    // so it only fires for a form the schema let through.
    this.addEventListener('submit', e => { e.preventDefault(); void this.submit(); });
    this.$<HTMLElement>('mgmt-confirm-ok').onclick = () =>
      this.$<HTMLFormElement>('mgmt-form').requestSubmit();
    void customElements.whenDefined('validation-enhancer-zod').then(() =>
      (this.querySelector('validation-enhancer-zod') as ValidationEnhancerZod)
        .setZodSchema(ManagementConfirmFormSchema));

    this.localizeTimes();
    // Rendered without the server's state (astro dev's own render): load now.
    if (!this.$('mgmt-serving').querySelector('.cfg-row')) void this.refresh();
    this.armPoll();
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  /** Server-rendered <time> values are ISO; show them in this browser. */
  private localizeTimes(): void {
    this.querySelectorAll<HTMLTimeElement>('time[datetime]').forEach(t => {
      t.textContent = new Date(t.dateTime).toLocaleString();
    });
  }

  private toast(message: string, variant: string, icon: string): void {
    const host = document.querySelector('wa-toast'); // Base.astro's stack
    (host as WaToast | null)?.create(message, { variant, icon, duration: 8000 });
  }

  private errorToast(fallback: string, body: { error?: string } = {}): void {
    this.toast(body.error ?? fallback, 'danger', 'triangle-exclamation');
  }

  private notAnswered(failure: SignedInFetchFailure, fallback: string): void {
    switch (failure.errorCode) {
      case 'signed_out': return; // the page is already on its way to /login
      case 'network_error': this.errorToast(fallback, { error: failure.errorMessage ?? 'network error' }); return;
      default: return failure satisfies never;
    }
  }

  /** The sha the preview region was rendered for (the current pick). */
  private selected(): string | null {
    return this.$('mgmt-preview').dataset.sha ?? null;
  }

  /** Re-render the data regions from the partial (the pick rides along as
   *  ?sha= so the preview region follows the selection). A failed fetch
   *  keeps what is shown. */
  private async refresh(sha: string | null = this.selected()): Promise<void> {
    const q = sha ? `?sha=${encodeURIComponent(sha)}` : '';
    const sent = await signedInFetch(`${BASE}/partials/management${q}`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (!r.ok) return;
    const fresh = parseServerHTML(await r.text());
    const box = document.createElement('div');
    for (const node of fresh) box.append(node);
    box.querySelectorAll<HTMLElement>('[data-refresh][id]').forEach(region => {
      this.querySelector(`#${CSS.escape(region.id)}`)?.replaceWith(document.importNode(region, true));
    });
    this.localizeTimes();
    this.armPoll();
  }

  private armPoll(): void {
    const cadence = this.buildActive() ? POLL_FAST_MS : POLL_SLOW_MS;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      // Not while the restart watcher owns the page — it reloads us.
      if (this.$('mgmt-restart').classList.contains('hidden')) void this.refresh();
    }, cadence);
  }

  /** Is a build in flight, per the (just-rendered) history table? */
  private buildActive(): boolean {
    return this.$('mgmt-releases').querySelector('.mgmt-status.st-pending, .mgmt-status.st-building') !== null;
  }

  private async pick(sha: string): Promise<void> {
    await this.refresh(sha);
  }

  // ---- the confirm dialog (password re-verification) ----

  private confirm(pending: Pending): void {
    this.pending = pending;
    const label = pending.kind === 'build'
      ? `build ${pending.sha.slice(0, 12)}… from the workspace checkout`
      : pending.target === 'image'
        ? 'roll back to the image copy'
        : `activate release ${pending.target.slice(0, 12)}…`;
    this.$('mgmt-dialog').setAttribute('label', label);
    this.$('mgmt-dialog-text').textContent =
      `${label}? The server re-checks the protected set first; wrong credentials change nothing.`;
    this.$('mgmt-confirm-label').textContent = pending.kind === 'build' ? 'build' : 'activate';
    this.$<WaCheckbox>('mgmt-confirm-box').checked = false;
    this.$('mgmt-confirm-error').textContent = '';
    for (const id of ['mgmt-username', 'mgmt-password']) {
      const field = this.$<WaInput>(id);
      field.setCustomValidity('');
      field.classList.remove('valid', 'invalid');
      field.removeAttribute('aria-invalid');
      const error = field.getAttribute('aria-errormessage');
      if (error) this.querySelector(`#${CSS.escape(error)}`)!.textContent = '';
    }
    this.$<WaDialog>('mgmt-dialog').open = true;
    this.$<WaInput>('mgmt-username').focus();
  }

  /** Runs only for a submit the enhancer let through (username + password
   *  passed the shared schema); the checkbox is this dialog's own
   *  explicit-confirm, checked here. */
  private async submit(): Promise<void> {
    if (this.inflight || this.pending === null) return;
    if (!this.$<WaCheckbox>('mgmt-confirm-box').checked) {
      this.$('mgmt-confirm-error').textContent = 'tick the checkbox — this restarts the web server.';
      return;
    }
    const body = {
      confirm: true,
      username: this.$<WaInput>('mgmt-username').value ?? '',
      password: this.$<WaInput>('mgmt-password').value ?? '',
      ...(this.pending.kind === 'build' ? { sha: this.pending.sha } : { target: this.pending.target }),
    };
    const url = this.pending.kind === 'build' ? '/api/management/build' : '/api/management/activate';
    const pending = this.pending;
    this.inflight = true;
    try {
      const sent = await signedInFetch(`${BASE}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!sent.ok) { this.notAnswered(sent, 'no answer'); return; }
      const r = sent.data.response;
      const answered = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) {
        this.errorToast(r.status === 401 ? 'wrong username or password' : 'refused', answered);
        if (r.status === 401) this.$<WaInput>('mgmt-password').focus();
        return;
      }
      this.$<WaDialog>('mgmt-dialog').open = false;
      if (pending.kind === 'build') {
        this.toast(`build of ${pending.sha.slice(0, 12)}… requested — watching the builder`, 'success', 'circle-check');
        void this.refresh(this.selected());
      } else {
        this.awaitRestart();
      }
    } finally {
      this.inflight = false;
    }
  }

  /** After an activation: the server exits through its graceful shutdown
   *  and comes back on the new release (docker's restart policy; a bare
   *  host install needs its supervisor). Watch for it to answer again,
   *  then reload into the new page. The session cookie survives — login
   *  sessions live in the state db, not the process. */
  private awaitRestart(): void {
    const callout = this.$<WaCallout>('mgmt-restart');
    const text = this.$('mgmt-restart-text');
    callout.classList.remove('hidden');
    this.$<WaDialog>('mgmt-dialog').open = false;
    const started = Date.now();
    // First look after the restart delay + drain window: an immediate
    // poll would hit the OLD process and reload into the old page.
    const watch = setInterval(() => {
      if (Date.now() - started < 4_000) return;
      if (Date.now() - started > RESTART_WAIT_MS) {
        clearInterval(watch);
        text.textContent = 'still no answer — check the container (docker compose ps / logs webpi), then reload.';
        return;
      }
      fetch(`${BASE}/api/management`, { cache: 'no-store' }).then(() => {
        clearInterval(watch);
        location.reload();
      }).catch(() => { /* still down — keep watching */ });
    }, 1000);
  }
}

if (!customElements.get('management-app')) customElements.define('management-app', ManagementApp);
