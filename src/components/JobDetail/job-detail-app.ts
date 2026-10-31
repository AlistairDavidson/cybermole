// <job-detail>: wires the server-rendered /jobs/:name page's log buttons and
// refreshes from /partials/jobs/<name> on the 15 s poll and on job events.
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
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '../RunHistory/run-history';

export class JobDetailApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private logViewer = new RunLogViewer(this, () => this.jobName);

  /** Read from the fragment, so a swapped-in refresh is authoritative. */
  private get jobName(): string | null {
    return this.querySelector('#job-detail')?.getAttribute('data-job') ?? null;
  }

  connectedCallback(): void {
    // Delegated across the swapped region.
    this.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-log]');
      if (button) void this.logViewer.show(Number(button.dataset.log));
    });
    this.pollTimer = setInterval(() => {
      void this.load();
    }, 15000);
    this.unsubscribeEvents = subscribeJobsEvents(() => void this.load());
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  /** A failed fetch keeps what's shown; a 404 means the job is gone. */
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
