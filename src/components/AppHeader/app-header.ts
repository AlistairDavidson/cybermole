// <app-header>: the global bar, wa-page's header slot. Links are wa-button
// anchors; sign-out and the drawer toggle's semantics are wired here.
import { BASE } from '../../base';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

export class AppHeader extends HTMLElement {
  private navObserver: MutationObserver | null = null;

  connectedCallback(): void {
    (this.querySelector('#sign-out') as HTMLElement | null)?.addEventListener(
      'click',
      () => void this.signOut(),
    );
    // The drawer toggle's disclosure semantics follow wa-page's nav-open,
    // whichever way it flipped (toggle, light-dismiss, Escape).
    const page = this.closest('wa-page');
    if (page) {
      this.navObserver = new MutationObserver(() => this.syncNavToggle(page));
      this.navObserver.observe(page, { attributeFilter: ['nav-open'] });
    }
  }

  disconnectedCallback(): void {
    this.navObserver?.disconnect();
    this.navObserver = null;
  }

  private syncNavToggle(page: Element): void {
    const button = this.querySelector('#nav-drawer-toggle');
    if (!button) return;
    const open = page.hasAttribute('nav-open');
    const label = open ? 'close the workspace drawer' : 'open the workspace drawer';
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', label);
    const icon = button.querySelector('wa-icon');
    icon?.setAttribute('name', open ? 'xmark' : 'bars');
    icon?.setAttribute('label', label);
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
