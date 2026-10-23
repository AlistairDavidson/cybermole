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
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
// Registers <validation-enhancer-zod> (and the base <validation-enhancer>).
import 'validation-enhancer/zod';
import type { ValidationEnhancerZod } from 'validation-enhancer/zod';
import { JobSaveSchema } from '../../schemas/jobs';
import type { JobRunView } from '../../lib/jobs';
import { subscribeJobsEvents } from '../jobs-events';
import { RunLogViewer } from './run-log';
import { fmtDuration, fmtRunTime } from './run-format';

type WaDialog = HTMLElement & { open: boolean };
/** wa-input / wa-textarea / wa-select surface used here. An empty
 *  wa-input's value is null, not ''; an unselected wa-select's is ''. */
type WaFormControl = HTMLElement & {
  value: string | null;
  disabled: boolean;
  setCustomValidity(message: string): void;
};
type WaSelect = HTMLElement & { value: string };
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

/** What the dialog edits — read off a card's edit button (the app tag
 *  as the tagged app's id, '' when the job is untagged). */
interface JobFields {
  name: string;
  schedule: string;
  command: string;
  app: string;
}

/** The picker's options, from the swapped-in list's data-apps (the same
 *  server render that listed the jobs — refreshed by the 15 s poll). */
interface AppChoice {
  id: string;
  name: string;
}

export class JobsApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private validateTimer: ReturnType<typeof setTimeout> | null = null;
  /** /ws/events teardown (plan §7's live consistency — jobs-events.ts). */
  private unsubscribeEvents: (() => void) | null = null;
  private deleting: string | null = null;
  /** The job whose history the runs dialog shows. */
  private runsJob: string | null = null;
  /** The shared log-tail viewer (run-log.ts) over the dialog's box. */
  private logViewer = new RunLogViewer(this, () => this.runsJob);
  private inflight = false;

  connectedCallback(): void {
    (this.querySelector('#jobs-new') as HTMLElement).onclick = () => this.openDialog(null);
    // Card actions, delegated: refreshed cards need no rewiring.
    this.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest<HTMLElement>(
        '[data-run], [data-edit], [data-del], [data-runs], [data-log]',
      );
      if (!button) return;
      const { run, edit, del, runs, log, schedule, command, app } = button.dataset;
      if (run) void this.run(run);
      else if (edit)
        this.openDialog({
          name: edit,
          schedule: schedule ?? '',
          command: command ?? '',
          app: app ?? '',
        });
      else if (del) this.confirmDelete(del);
      else if (runs) void this.openRuns(runs);
      else if (log) void this.logViewer.show(Number(log));
    });
    // The footer button lives outside the form (dialog footer slot):
    // submit the form so <validation-enhancer-zod> validates it first.
    (this.querySelector('#job-save') as HTMLElement).onclick = () => this.jobForm().requestSubmit();
    (this.querySelector('#job-delete-confirm') as HTMLElement).onclick = () => this.deleteJob();
    // #run-log-close is wired by the shared RunLogViewer (run-log.ts).
    (this.querySelector('#job-schedule') as WaFormControl).addEventListener('input', () =>
      this.queueValidate(),
    );
    // Valid submits only: the enhancer stops an invalid one from
    // propagating, so the save listener sits ABOVE it — a listener on the
    // form itself would fire (target phase) before validation ran.
    this.addEventListener('submit', e => {
      e.preventDefault();
      void this.save();
    });
    // The dialog validates against the same schema POST /api/jobs parses with.
    void customElements
      .whenDefined('validation-enhancer-zod')
      .then(() =>
        (this.querySelector('validation-enhancer-zod') as ValidationEnhancerZod).setZodSchema(
          JobSaveSchema,
        ),
      );

    // The list is server-rendered; the 15 s poll keeps it fresh (and
    // retries a failed listing — the partial answers 500 with no fragment
    // then, so what is shown stays until a good one lands).
    this.pollTimer = setInterval(() => {
      void this.load();
    }, 15000);
    // task/jobs-page (plan §7): live consistency — the /ws/events
    // subscription runs the SAME partial refresh the poll runs (load),
    // debounced inside jobs-events.ts. Whoever mutated the job (this
    // page, another tab, an agent over the internal socket API of plan
    // §4), the list follows within a moment instead of up to 15 s; the
    // poll above stays as the safety net.
    this.unsubscribeEvents = subscribeJobsEvents(() => void this.load());
    // The job detail page's edit entry lands here with the dialog open
    // (ONE editor — the /jobs dialog — reused, no second form to drift):
    // /jobs?edit=<name>. The URL is cleaned so a reload does not reopen
    // the dialog; a name that has no card (deleted, bad link) is a no-op.
    const wanted = new URLSearchParams(location.search).get('edit');
    if (wanted) {
      history.replaceState(null, '', `${BASE}/jobs`);
      const button = this.querySelector<HTMLElement>(
        `#jobs-list [data-edit="${CSS.escape(wanted)}"]`,
      );
      if (button)
        this.openDialog({
          name: wanted,
          schedule: button.dataset.schedule ?? '',
          command: button.dataset.command ?? '',
          app: button.dataset.app ?? '',
        });
    }
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  private toast(message: string, variant: string, icon: string): void {
    void (this.querySelector('wa-toast') as WaToast | null)?.create(message, {
      variant,
      icon,
      duration: 6000,
    });
  }

  /** A failed action's toast: the server's error (and detail) when it
   *  answered with one, else `fallback`. */
  private errorToast(
    fallback: string,
    body: { error?: string; detail?: string | null } = {},
  ): void {
    this.toast(
      `${body.error ?? fallback}${body.detail ? ` — ${body.detail}` : ''}`,
      'danger',
      'triangle-exclamation',
    );
  }

  /** An action whose request got no answer. Signed out needs no toast:
   *  the page is already on its way to /login. */
  private notAnswered(failure: SignedInFetchFailure, fallback: string): void {
    switch (failure.errorCode) {
      case 'signed_out':
        return;
      case 'network_error':
        this.errorToast(fallback, { detail: failure.errorMessage ?? 'network error' });
        return;
      default:
        return failure satisfies never;
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
    const dlg = this.querySelector('#job-dialog') as WaDialog;
    const name = this.querySelector('#job-name') as WaFormControl;
    const schedule = this.querySelector('#job-schedule') as WaFormControl;
    const command = this.querySelector('#job-command') as WaFormControl;
    dlg.setAttribute('label', job ? `edit job ${job.name}` : 'new job');
    name.value = job?.name ?? '';
    name.disabled = job !== null; // the name is the job identity — no renames
    schedule.value = job?.schedule ?? '';
    command.value = job?.command ?? '';
    this.setAppOptions(job?.app ?? '');
    this.clearFieldErrors();
    this.setFeedback(null);
    void this.validate();
    dlg.open = true;
    (job ? schedule : name).focus();
  }

  /** (Re)populate the tag picker from the swapped-in list's data-apps and
   *  select the tagged app — '' clears it. */
  private setAppOptions(selected: string): void {
    const select = this.querySelector('#job-app') as WaSelect | null;
    if (!select) return;
    let apps: AppChoice[] = [];
    try {
      apps = JSON.parse(
        this.querySelector('#jobs-list')?.getAttribute('data-apps') ?? '[]',
      ) as AppChoice[];
    } catch {
      /* a bad payload must not break the dialog — the picker just offers nothing */
    }
    select.textContent = ''; // options are rebuilt, never appended to
    for (const app of apps) {
      const option = document.createElement('wa-option');
      option.value = app.id;
      option.textContent = app.name;
      select.append(option);
    }
    select.value = apps.some(a => a.id === selected) ? selected : '';
  }

  private queueValidate(): void {
    if (this.validateTimer) clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => {
      void this.validate();
    }, 350);
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
    if (!schedule) {
      this.setFeedback(null);
      return;
    }
    const sent = await signedInFetch(`${BASE}/api/jobs/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule }),
    });
    // No answer is transient — the save path re-validates server-side.
    if (!sent.ok || !sent.data.response.ok) return;
    const check = (await sent.data.response.json().catch(() => null)) as CalendarCheck | null;
    if (check) this.setFeedback(check);
  }

  /** Runs only for a submit the enhancer let through (the schema passed
   *  client-side); the server re-validates with the same schema. The app
   *  tag is not one of the enhancer's fields (an empty optional select
   *  would trip the uuid pattern) — it rides along as null when unset. */
  private async save(): Promise<void> {
    if (this.inflight) return;
    const value = (name: string): string => this.field(name)?.value ?? '';
    const name = value('name');
    const schedule = value('schedule');
    const command = value('command');
    const app = (this.querySelector('#job-app') as WaSelect | null)?.value ?? '';
    this.inflight = true;
    try {
      const sent = await signedInFetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, schedule, command, appId: app === '' ? null : app }),
      });
      if (!sent.ok) {
        this.notAnswered(sent, 'could not save job');
        return;
      }
      const r = sent.data.response;
      const body = (await r.json().catch(() => ({}))) as {
        name?: string;
        session?: string;
        error?: string;
        detail?: string | null;
        issues?: Record<string, string>;
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
    const sent = await signedInFetch(`${BASE}/api/jobs/${encodeURIComponent(name)}/run`, {
      method: 'POST',
    });
    if (!sent.ok) {
      this.notAnswered(sent, 'could not run job');
      return;
    }
    const r = sent.data.response;
    const body = (await r.json().catch(() => ({}))) as {
      session?: string;
      error?: string;
      detail?: string | null;
    };
    if (r.ok) {
      this.toast(
        `run started — view it from this card (session ${body.session ?? `cybermole-${name}`})`,
        'success',
        'circle-check',
      );
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
    const sent = await signedInFetch(`${BASE}/api/jobs/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    (this.querySelector('#job-delete-dialog') as WaDialog).open = false;
    this.deleting = null;
    if (!sent.ok) {
      this.notAnswered(sent, 'could not delete job');
      return;
    }
    const r = sent.data.response;
    const body = (await r.json().catch(() => ({}))) as { error?: string; detail?: string | null };
    if (r.ok) {
      this.toast(`job ${name} deleted`, 'success', 'circle-check');
    } else {
      this.errorToast('could not delete job', body);
    }
    await this.load();
  }

  // ---- run history + log tail (plan §9) ----

  /** Open the per-job run history: GET /api/jobs/:name/runs, rendered
   *  into the dialog body (numbers + closed unions only — nothing
   *  untrusted is templated). */
  private async openRuns(name: string): Promise<void> {
    this.runsJob = name;
    this.logViewer.hide();
    const dlg = this.querySelector('#runs-dialog') as WaDialog;
    const body = this.querySelector('#runs-body') as HTMLElement;
    dlg.setAttribute('label', `run history — ${name}`);
    body.innerHTML = '<p class="runs-empty">loading…</p>';
    dlg.open = true;
    const sent = await signedInFetch(`${BASE}/api/jobs/${encodeURIComponent(name)}/runs`);
    if (!sent.ok) {
      this.notAnswered(sent, 'could not load run history');
      return;
    }
    const r = sent.data.response;
    const payload = r.ok
      ? ((await r.json().catch(() => null)) as { runs?: JobRunView[] } | null)
      : null;
    if (!payload) {
      body.innerHTML = '<p class="runs-empty">the run history could not be read</p>';
      return;
    }
    const runs = payload.runs ?? [];
    if (runs.length === 0) {
      body.innerHTML = '<p class="runs-empty">no runs recorded yet — "run now" fires one.</p>';
      return;
    }
    const row = (u: JobRunView): string => {
      const exit =
        u.exitCode === null
          ? '<span class="run-exit unknown">—</span>'
          : `<span class="run-exit ${u.exitCode === 0 ? 'ok' : 'failed'}">exit ${u.exitCode}</span>`;
      const duration =
        u.finishedAt === null
          ? '<span class="run-duration">—</span>'
          : `<span class="run-duration">${fmtDuration(u.firedAt, u.finishedAt)}</span>`;
      return (
        `<div class="run-row">` +
        `<span class="run-when">${fmtRunTime(u.firedAt)}</span>` +
        `<span class="run-origin">${u.origin}</span>` +
        `${duration}${exit}` +
        `<span class="run-log-cell">${
          u.hasLog
            ? `<wa-button size="xs" appearance="plain" data-log="${u.firedAt}">log</wa-button>`
            : ''
        }</span>` +
        `</div>`
      );
    };
    body.innerHTML =
      '<div class="run-row run-head">' +
      '<span class="run-when">fired</span><span class="run-origin">origin</span>' +
      '<span class="run-duration">duration</span><span class="run-exit">exit</span>' +
      '<span class="run-log-cell"></span></div>' +
      runs.map(row).join('');
  }
}

if (!customElements.get('jobs-app')) customElements.define('jobs-app', JobsApp);
