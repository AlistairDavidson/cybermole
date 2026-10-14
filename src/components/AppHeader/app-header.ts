// app-header.ts — <app-header>: the global bar on every signed-in page
// (AppHeader.astro SSRs it via Base.astro). The section links are real
// anchors (wa-button with href) and need no JavaScript; the one wired
// control is sign-out — POST /logout (the verb lives in server/main.ts:
// session cookie clearing + socket tracking), then follow to /login.
import { BASE } from '../../base';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

/** Minimal typing for <wa-toast>.create() — Base.astro renders the
 *  app-wide stack the failure toast goes to. */
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

export class AppHeader extends HTMLElement {
  connectedCallback(): void {
    (this.querySelector('#sign-out') as HTMLElement | null)
      ?.addEventListener('click', () => void this.signOut());
  }

  private async signOut(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/logout`, { method: 'POST' });
    if (!sent.ok) { this.notAnswered(sent); return; }
    location.href = `${BASE}/login`;
  }

  /** A request that got no answer. Signed out needs no toast: the page is
   *  already on its way to /login. */
  private notAnswered(failure: SignedInFetchFailure): void {
    switch (failure.errorCode) {
      case 'signed_out': return;
      case 'network_error':
        (document.querySelector('wa-toast') as WaToast | null)?.create(
          'network error — try again',
          { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 },
        );
        return;
      default: return failure satisfies never;
    }
  }
}

if (!customElements.get('app-header')) customElements.define('app-header', AppHeader);
