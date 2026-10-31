// <run-history>: stamps RunHistory.astro's row skeleton for runs fetched
// client-side (the jobs page's runs dialog). The markup is the .astro's;
// this fills fields and drops the optional cells a run doesn't have.
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/format-date/format-date.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/skeleton/skeleton.js';
import { fmtDuration } from '../JobsApp/run-format';
import { isoOf } from '../../lib/web/format-attrs';
import type { JobRunView } from '../../lib/jobs/jobs';

type State = 'loading' | 'error' | 'empty' | 'table';

function stampRow(skeleton: HTMLTemplateElement, run: JobRunView): HTMLTableRowElement {
  const row = document.importNode(skeleton.content, true).firstElementChild as HTMLTableRowElement;
  row.querySelector('.run-when')!.setAttribute('date', isoOf(run.firedAt));
  row.querySelector('.run-origin')!.textContent = run.origin;
  row.querySelector('.run-duration')!.textContent =
    run.finishedAt === null ? '—' : fmtDuration(run.firedAt, run.finishedAt);
  const badge = row.querySelector<HTMLElement>('[data-optional="exit"]')!;
  if (run.exitCode === null) {
    badge.remove();
  } else {
    row.querySelector('[data-optional="unknown"]')!.remove();
    const ok = run.exitCode === 0;
    badge.classList.add(ok ? 'ok' : 'failed');
    badge.setAttribute('variant', ok ? 'success' : 'danger');
    badge.textContent = `exit ${run.exitCode}`;
  }
  const log = row.querySelector<HTMLElement>('[data-optional="log"]')!;
  if (run.hasLog) log.dataset.log = String(run.firedAt);
  else log.remove();
  for (const el of row.querySelectorAll('[data-optional]')) el.removeAttribute('data-optional');
  return row;
}

export class RunHistory extends HTMLElement {
  /** undefined shows the skeleton, null the unreadable callout. */
  show(runs: JobRunView[] | null | undefined): void {
    const state: State =
      runs === undefined
        ? 'loading'
        : runs === null
          ? 'error'
          : runs.length === 0
            ? 'empty'
            : 'table';
    for (const el of this.querySelectorAll<HTMLElement>(':scope > [data-state]'))
      el.classList.toggle('hidden', el.dataset.state !== state);
    const body = this.querySelector('tbody');
    const skeleton = this.querySelector<HTMLTemplateElement>(':scope > template[data-row]');
    if (!body || !skeleton) return;
    body.replaceChildren(...(runs ?? []).map(run => stampRow(skeleton, run)));
  }
}

if (!customElements.get('run-history')) customElements.define('run-history', RunHistory);
