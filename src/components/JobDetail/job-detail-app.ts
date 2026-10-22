// job-detail-app.ts — <job-detail>: enhances the server-rendered
// /jobs/:name page (JobDetail.astro / JobDetailBody.astro). The detail
// arrives as HTML; this element wires the log-tail buttons (delegated —
// refreshed rows need no rewiring, the shared RunLogViewer fetches), the
// 15 s refresh that swaps in /partials/jobs/<name>, and the /ws/events
// subscription (jobs-events.ts) that runs the SAME refresh the moment
// anything changed the job, whoever did it (plan §7 — an agent's
// mutation over the internal socket API included). One rendering path:
// the partial swap; no granular DOM patching.
import { BASE } from '../../base';
import { parseServerHTML } from '../html';
import { signedInFetch } from '../signed-in-fetch';
import { subscribeJobsEvents } from '../jobs-events';
import { RunLogViewer } from '../JobsApp/run-log';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';

export class JobDetailApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private logViewer = new RunLogViewer(this, () => this.jobName);

  /** The job this page shows — read from the fragment's data-job, so a
   *  swapped-in refresh is authoritative (never element-held state). */
  private get jobName(): string | null {
    return this.querySelector('#job-detail')?.getAttribute('data-job') ?? null;
  }

  connectedCallback(): void {
    // Log buttons, delegated across the swapped region (the same
    // data-log contract the runs dialog's rows carry).
    this.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-log]');
      if (button) void this.logViewer.show(Number(button.dataset.log));
    });
    this.pollTimer = setInterval(() => {
      void this.load();
    }, 15000);
    // task/jobs-page (plan §7): live consistency — same refresh path as
    // the poll, debounced in jobs-events.ts; the poll stays as the net.
    this.unsubscribeEvents = subscribeJobsEvents(() => void this.load());
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  /** Swap in a fresh server-rendered fragment. A failed fetch keeps
   *  what is shown; a 404 means the job is gone — back to the list. */
  private async load(): Promise<void> {
    const name = this.jobName;
    if (!name) return;
    const sent = await signedInFetch(`${BASE}/partials/jobs/${encodeURIComponent(name)}`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (r.status === 404) {
      location.href = `${BASE}/jobs`;
      return;
    }
    if (!r.ok) return;
    this.querySelector('#job-detail')?.replaceWith(...parseServerHTML(await r.text()));
  }
}

if (!customElements.get('job-detail')) customElements.define('job-detail', JobDetailApp);
