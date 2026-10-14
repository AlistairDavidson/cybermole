// jobs-app.ts — <jobs-app>: enhances the server-rendered /jobs page
// (JobsApp.astro, JobsList.astro / JobCard.astro). The list arrives as
// HTML; this element wires the actions (run / edit / delete by delegated
// clicks — the cards carry their data), the create/edit dialog, and a 15 s
// refresh that swaps in /partials/jobs-list.
import type { CalendarCheck } from '../../lib/types';
import { BASE } from '../../base';
import { parseServerHTML } from '../html';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
// Registers <validation-enhancer-zod> (and the base <validation-enhancer>).
import 'validation-enhancer/zod';
import type { ValidationEnhancerZod } from 'validation-enhancer/zod';
import { JobSaveSchema } from '../../schemas/jobs';

type WaDialog = HTMLElement & { open: boolean };
/** wa-input / wa-textarea surface used here. An empty wa-input's value is
 *  null, not ''. */
type WaFormControl = HTMLElement & {
  value: string | null; disabled: boolean; setCustomValidity(message: string): void;
};
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

/** What the dialog edits — read off a card's edit button. */
interface JobFields { name: string; schedule: string; command: string }

export class JobsApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private validateTimer: ReturnType<typeof setTimeout> | null = null;
  private editing: string | null = null;
  private deleting: string | null = null;
  private inflight = false;

  connectedCallback(): void {
    (this.querySelector('#jobs-new') as HTMLElement).onclick = () => this.openDialog(null);
    // Card actions, delegated: refreshed cards need no rewiring.
    this.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-run], [data-edit], [data-del]');
      if (!button) return;
      const { run, edit, del, schedule, command } = button.dataset;
      if (run) void this.run(run);
      else if (edit) this.openDialog({ name: edit, schedule: schedule ?? '', command: command ?? '' });
      else if (del) this.confirmDelete(del);
    });
    // The footer button lives outside the form (dialog footer slot):
    // submit the form so <validation-enhancer-zod> validates it first.
    (this.querySelector('#job-save') as HTMLElement).onclick = () => this.jobForm().requestSubmit();
    (this.querySelector('#job-delete-confirm') as HTMLElement).onclick = () => this.deleteJob();
    (this.querySelector('#job-schedule') as WaFormControl)
      .addEventListener('input', () => this.queueValidate());
    // Valid submits only: the enhancer stops an invalid one from
    // propagating, so the save listener sits ABOVE it — a listener on the
    // form itself would fire (target phase) before validation ran.
    this.addEventListener('submit', e => { e.preventDefault(); void this.save(); });
    // The dialog validates against the same schema POST /api/jobs parses with.
    void customElements.whenDefined('validation-enhancer-zod').then(() =>
      (this.querySelector('validation-enhancer-zod') as ValidationEnhancerZod).setZodSchema(JobSaveSchema));

    // The list is server-rendered; the 15 s poll keeps it fresh (and
    // retries a failed listing — the partial answers 500 with no fragment
    // then, so what is shown stays until a good one lands).
    this.pollTimer = setInterval(() => this.load(), 15000);
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.validateTimer) clearTimeout(this.validateTimer);
  }

  private toast(message: string, variant: string, icon: string): void {
    (this.querySelector('wa-toast') as WaToast | null)?.create(message, {
      variant, icon, duration: 6000,
    });
  }

  /** A failed action's toast: the server's error (and detail) when it
   *  answered with one, else `fallback`. */
  private errorToast(fallback: string, body: { error?: string; detail?: string | null } = {}): void {
    this.toast(`${body.error ?? fallback}${body.detail ? ` — ${body.detail}` : ''}`,
      'danger', 'triangle-exclamation');
  }

  /** An action whose request got no answer. Signed out needs no toast:
   *  the page is already on its way to /login. */
  private notAnswered(failure: SignedInFetchFailure, fallback: string): void {
    switch (failure.errorCode) {
      case 'signed_out': return;
      case 'network_error': this.errorToast(fallback, { detail: failure.errorMessage ?? 'network error' }); return;
      default: return failure satisfies never;
    }
  }

  /** Swap in a fresh server-rendered list. A failed fetch keeps what is shown. */
  private async load(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/partials/jobs-list`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (!r.ok) return;
    const fresh = parseServerHTML(await r.text());
    this.querySelector('#jobs-list')?.replaceWith(...fresh);
  }

  // ---- create / edit ----

  private jobForm(): HTMLFormElement {
    return this.querySelector('#job-form') as HTMLFormElement;
  }

  private field(name: string): WaFormControl | null {
    return this.jobForm().querySelector(`[name="${name}"]`) as WaFormControl | null;
  }

  /** The field's message element (its hint slot — WaField). */
  private fieldError(control: WaFormControl): HTMLElement | null {
    const id = control.getAttribute('aria-errormessage');
    return id ? this.querySelector(`#${CSS.escape(id)}`) : null;
  }

  /** Reset every field's validation state (a re-opened dialog starts clean). */
  private clearFieldErrors(): void {
    for (const name of ['name', 'schedule', 'command']) {
      const control = this.field(name);
      if (!control) continue;
      control.setCustomValidity('');
      control.classList.remove('valid', 'invalid');
      control.removeAttribute('aria-invalid');
      const message = this.fieldError(control);
      if (message) message.textContent = '';
    }
  }

  /** A 400's per-field issues, shown where the client-side errors go. The
   *  custom validity clears itself once the user edits the field (the
   *  enhancer re-validates against the schema). */
  private showFieldErrors(issues: Record<string, string>): void {
    for (const [name, text] of Object.entries(issues)) {
      const control = this.field(name);
      if (!control) continue;
      control.setCustomValidity(text);
      control.classList.add('invalid');
      control.setAttribute('aria-invalid', 'true');
      const message = this.fieldError(control);
      if (message) message.textContent = text;
    }
  }

  private openDialog(job: JobFields | null): void {
    this.editing = job?.name ?? null;
    const dlg = this.querySelector('#job-dialog') as WaDialog;
    const name = this.querySelector('#job-name') as WaFormControl;
    const schedule = this.querySelector('#job-schedule') as WaFormControl;
    const command = this.querySelector('#job-command') as WaFormControl;
    dlg.setAttribute('label', job ? `edit job ${job.name}` : 'new job');
    name.value = job?.name ?? '';
    name.disabled = job !== null; // the name is the job identity — no renames
    schedule.value = job?.schedule ?? '';
    command.value = job?.command ?? '';
    this.clearFieldErrors();
    this.setFeedback(null);
    this.validate();
    dlg.open = true;
    (job ? schedule : name).focus();
  }

  private queueValidate(): void {
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => this.validate(), 350);
  }

  private setFeedback(c: CalendarCheck | null): void {
    const el = this.querySelector('#schedule-feedback') as HTMLElement;
    el.className = 'schedule-feedback';
    el.textContent = '';
    if (!c) return;
    if (c.valid) {
      el.className = 'schedule-feedback ok';
      el.textContent = c.next ? `next: ${c.next}` : 'valid';
    } else {
      el.className = 'schedule-feedback err';
      el.textContent = c.error ?? 'invalid schedule';
    }
  }

  private async validate(): Promise<void> {
    const schedule = ((this.querySelector('#job-schedule') as WaFormControl).value ?? '').trim();
    if (!schedule) { this.setFeedback(null); return; }
    const sent = await signedInFetch(`${BASE}/api/jobs/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule }),
    });
    // No answer is transient — the save path re-validates server-side.
    if (!sent.ok || !sent.data.response.ok) return;
    const check = await sent.data.response.json().catch(() => null) as CalendarCheck | null;
    if (check) this.setFeedback(check);
  }

  /** Runs only for a submit the enhancer let through (the schema passed
   *  client-side); the server re-validates with the same schema. */
  private async save(): Promise<void> {
    if (this.inflight) return;
    const value = (name: string): string => this.field(name)?.value ?? '';
    const name = value('name');
    const schedule = value('schedule');
    const command = value('command');
    this.inflight = true;
    try {
      const sent = await signedInFetch(`${BASE}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, schedule, command }),
      });
      if (!sent.ok) { this.notAnswered(sent, 'could not save job'); return; }
      const r = sent.data.response;
      const body = await r.json().catch(() => ({})) as {
        name?: string; session?: string; error?: string; detail?: string | null; issues?: Record<string, string>;
      };
      if (!r.ok) {
        if (body.issues) this.showFieldErrors(body.issues);
        this.errorToast('could not save job', body);
        return;
      }
      (this.querySelector('#job-dialog') as WaDialog).open = false;
      this.toast(`job ${body.name ?? name} saved`, 'success', 'circle-check');
      await this.load();
    } finally {
      this.inflight = false;
    }
  }

  // ---- run / delete ----

  private async run(name: string): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/jobs/${encodeURIComponent(name)}/run`, { method: 'POST' });
    if (!sent.ok) { this.notAnswered(sent, 'could not run job'); return; }
    const r = sent.data.response;
    const body = await r.json().catch(() => ({})) as { session?: string; error?: string; detail?: string | null };
    if (r.ok) {
      this.toast(`run started — see Live (session ${body.session ?? `webpi-${name}`})`, 'success', 'circle-check');
    } else if (r.status === 409) {
      this.toast(body.error ?? 'previous run still active', 'warning', 'triangle-exclamation');
    } else {
      this.errorToast('could not run job', body);
    }
    await this.load();
  }

  private confirmDelete(name: string): void {
    this.deleting = name;
    (this.querySelector('#job-delete-text') as HTMLElement).textContent =
      `Delete job "${name}"? Removes its schedule and run history. ` +
      `A run that's currently live keeps its tmux session.`;
    (this.querySelector('#job-delete-dialog') as WaDialog).open = true;
  }

  private async deleteJob(): Promise<void> {
    if (!this.deleting) return;
    const name = this.deleting;
    const sent = await signedInFetch(`${BASE}/api/jobs/${encodeURIComponent(name)}`, { method: 'DELETE' });
    (this.querySelector('#job-delete-dialog') as WaDialog).open = false;
    this.deleting = null;
    if (!sent.ok) { this.notAnswered(sent, 'could not delete job'); return; }
    const r = sent.data.response;
    const body = await r.json().catch(() => ({})) as { error?: string; detail?: string | null };
    if (r.ok) {
      this.toast(`job ${name} deleted`, 'success', 'circle-check');
    } else {
      this.errorToast('could not delete job', body);
    }
    await this.load();
  }
}

if (!customElements.get('jobs-app')) customElements.define('jobs-app', JobsApp);
