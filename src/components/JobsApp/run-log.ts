// The run log-tail viewer shared by /jobs and /jobs/:name. Each page places
// the #run-log-box / #run-log-title / #run-log / #run-log-close markup.
import { BASE } from '../../base';
import { signedInFetch } from '../signed-in-fetch';
import { fmtRunTime } from './run-format';
interface WaToast {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
}

export class RunLogViewer {
  private wired = false;

  constructor(
    private root: HTMLElement,
    /** a getter, so a swapped fragment stays right */
    private jobOf: () => string | null,
  ) {}

  async show(firedAt: number): Promise<void> {
    const name = this.jobOf();
    if (!name) return;
    const box = this.root.querySelector('#run-log-box') as HTMLElement | null;
    const pre = this.root.querySelector('#run-log') as HTMLElement | null;
    const title = this.root.querySelector('#run-log-title') as HTMLElement | null;
    if (!box || !pre || !title) return;
    this.wireClose();
    pre.textContent = 'loading…';
    title.textContent = `log tail — run at ${fmtRunTime(firedAt)}`;
    box.classList.remove('hidden');
    const sent = await signedInFetch(
      `${BASE}/api/jobs/${encodeURIComponent(name)}/runs/${encodeURIComponent(String(firedAt))}/log`,
    );
    if (!sent.ok) {
      // signed_out needs no toast: the page is already heading to /login.
      if (sent.errorCode === 'network_error')
        this.toast(`could not load the run log — ${sent.errorMessage ?? 'network error'}`);
      return;
    }
    const r = sent.data.response;
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string; detail?: string | null };
      this.toast(
        `${body.error ?? 'could not load the run log'}${body.detail ? ` — ${body.detail}` : ''}`,
      );
      return;
    }
    const text = await r.text();
    if (r.headers.get('X-Run-Log-Truncated') === '1') {
      title.textContent += ' (larger than 1 MiB — showing the tail)';
    }
    pre.textContent = text === '' ? '(no output)' : text;
    pre.scrollTop = 0;
  }

  hide(): void {
    this.root.querySelector('#run-log-box')?.classList.add('hidden');
  }

  private wireClose(): void {
    if (this.wired) return;
    this.wired = true;
    (this.root.querySelector('#run-log-close') as HTMLElement | null)?.addEventListener(
      'click',
      () => this.hide(),
    );
  }

  private toast(message: string): void {
    void (this.root.querySelector('wa-toast') as WaToast | null)?.create(message, {
      variant: 'danger',
      icon: 'triangle-exclamation',
      duration: 6000,
    });
  }
}
