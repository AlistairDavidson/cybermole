// <jobs-app>: wires the server-rendered /jobs list (delegated card clicks),
// the create/edit dialog, and refreshes from /partials/jobs-list on the 15 s
// poll and on live job events.
import type { CalendarCheck } from '../../lib/platform/types';
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
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import 'validation-enhancer/zod';
import type { ValidationEnhancerZod } from 'validation-enhancer/zod';
import { JobSaveSchema } from '../../schemas/jobs';
import type { JobRunView } from '../../lib/jobs/jobs';
import { subscribeJobsEvents } from '../jobs-events';
import { RunLogViewer } from './run-log';
import type { RunHistory } from '../RunHistory/run-history';
import '../RunHistory/run-history';

type WaDialog = HTMLElement & { open: boolean };
/** An empty wa-input's value is null, not ''; an unselected wa-select's is ''. */
type WaFormControl = HTMLElement & {
  value: string | null;
  disabled: boolean;
  setCustomValidity(message: string): void;
};
type WaSelect = HTMLElement & { value: string };
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

/** Read off a card's edit button; app is the tag's id, '' when untagged. */
interface JobFields {
  name: string;
  schedule: string;
  command: string;
  app: string;
}

export class JobsApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private validateTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private deleting: string | null = null;
  private runsJob: string | null = null;
  private logViewer = new RunLogViewer(this, () => this.runsJob);
  private inflight = false;

  connectedCallback(): void {
    (this.querySelector('#jobs-new') as HTMLElement).onclick = () => this.openDialog(null);
    // Delegated, so refreshed cards need no rewiring.
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
    // The footer button is outside the form; requestSubmit so the enhancer validates first.
    (this.querySelector('#job-save') as HTMLElement).onclick = () => this.jobForm().requestSubmit();
    (this.querySelector('#job-delete-confirm') as HTMLElement).onclick = () => this.deleteJob();
    (this.querySelector('#job-schedule') as WaFormControl).addEventListener('input', () =>
      this.queueValidate(),
    );
    // Above the enhancer: it stops invalid submits, and a listener on the
    // form itself would fire before validation.
    this.addEventListener('submit', e => {
      e.preventDefault();
      void this.save();
    });
    void customElements
      .whenDefined('validation-enhancer-zod')
      .then(() =>
        (this.querySelector('validation-enhancer-zod') as ValidationEnhancerZod).setZodSchema(
          JobSaveSchema,
        ),
      );

    // A failed partial answers 500 with no fragment, so what's shown stays.
    this.pollTimer = setInterval(() => {
      void this.load();
    }, 15000);
    // Live events refresh within a moment; the poll is the safety net.
    this.unsubscribeEvents = subscribeJobsEvents(() => void this.load());
    // /jobs?edit=<name> (from the job detail page) opens the one shared
    // editor. The URL is cleaned so a reload doesn't reopen it.
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

  /** The server's error and detail when it gave one, else `fallback`. */
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

  /** Signed out needs no toast: the page is already heading to /login. */
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

  /** A failed fetch keeps what's shown. */
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

  private fieldError(control: WaFormControl): HTMLElement | null {
    const id = control.getAttribute('aria-errormessage');
    return id ? this.querySelector(`#${CSS.escape(id)}`) : null;
  }

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

  /** The custom validity clears once the user edits and the enhancer re-validates. */
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
    name.disabled = job !== null; // the name is the identity: no renames
    schedule.value = job?.schedule ?? '';
    command.value = job?.command ?? '';
    this.setAppOptions(job?.app ?? '');
    this.clearFieldErrors();
    this.setFeedback(null);
    void this.validate();
    dlg.open = true;
    (job ? schedule : name).focus();
  }

  /** '' selects no app. The options are the list's template, so a
   *  refresh renews them. */
  private setAppOptions(selected: string): void {
    const select = this.querySelector('#job-app') as WaSelect | null;
    const options = this.querySelector<HTMLTemplateElement>(
      '#jobs-list template[data-app-options]',
    );
    if (!select || !options) return;
    select.replaceChildren(document.importNode(options.content, true));
    const ids = [...select.querySelectorAll('wa-option')].map(o => o.getAttribute('value'));
    select.value = ids.includes(selected) ? selected : '';
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
    // No answer is transient; the save re-validates server-side anyway.
    if (!sent.ok || !sent.data.response.ok) return;
    const check = (await sent.data.response.json().catch(() => null)) as CalendarCheck | null;
    if (check) this.setFeedback(check);
  }

  /** The app tag isn't an enhancer field (an empty optional select would
   *  trip the uuid pattern); it's sent as null when unset. */
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

  // ---- run history + log tail ----

  private async openRuns(name: string): Promise<void> {
    this.runsJob = name;
    this.logViewer.hide();
    const dlg = this.querySelector('#runs-dialog') as WaDialog;
    const history = this.querySelector('run-history') as RunHistory;
    dlg.setAttribute('label', `run history — ${name}`);
    history.show(undefined);
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
    history.show(payload ? (payload.runs ?? []) : null);
  }
}

if (!customElements.get('jobs-app')) customElements.define('jobs-app', JobsApp);
