// <app-header>: the global bar. Links are plain anchors; only sign-out is wired.
import { BASE } from '../../base';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

export class AppHeader extends HTMLElement {
  connectedCallback(): void {
    (this.querySelector('#sign-out') as HTMLElement | null)?.addEventListener(
      'click',
      () => void this.signOut(),
    );
    // The mobile drawer toggle (console pages only — CSS decides where it
    // shows): the drawer lives in the page's wa-page below this bar, so the
    // click is announced as an event for console-app to answer.
    (this.querySelector('#nav-drawer-toggle') as HTMLElement | null)?.addEventListener(
      'click',
      () => this.dispatchEvent(new CustomEvent('toggle-nav', { bubbles: true, composed: true })),
    );
  }

  private async signOut(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/logout`, { method: 'POST' });
    if (!sent.ok) {
      this.notAnswered(sent);
      return;
    }
    location.href = `${BASE}/login`;
  }

  /** Signed out needs no toast: the page is already heading to /login. */
  private notAnswered(failure: SignedInFetchFailure): void {
    switch (failure.errorCode) {
      case 'signed_out':
        return;
      case 'network_error':
        void (document.querySelector('wa-toast') as WaToast | null)?.create(
          'network error — try again',
          { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 },
        );
        return;
      default:
        return failure satisfies never;
    }
  }
}

if (!customElements.get('app-header')) customElements.define('app-header', AppHeader);
