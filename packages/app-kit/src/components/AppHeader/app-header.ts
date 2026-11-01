// <app-header>: the global bar, wa-page's header slot, on the console's
// pages and every app's. Links are wa-button anchors; the drawer toggle's
// semantics, the Apps menu and the account menu (settings, sign-out) are
// wired here. The console's base
// comes from the element's data-base, so the same module serves both.
import '../../wa-client';
import '@awesome.me/webawesome/dist/components/breadcrumb/breadcrumb.js';
import '@awesome.me/webawesome/dist/components/breadcrumb-item/breadcrumb-item.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { defineElement } from '../../element';
import { appMenuEntries, type AppMenuEntry } from '../../app-menu';
import { fetchMenuState } from './menu-state';
import './side-nav';

type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};
type WaSelectEvent = CustomEvent<{ item: HTMLElement }>;

function toastError(message: string): void {
  void (document.querySelector('wa-toast') as WaToast | null)?.create(message, {
    variant: 'danger',
    icon: 'triangle-exclamation',
    duration: 6000,
  });
}

function syncNavToggle(page: Element, button: Element): void {
  const open = page.hasAttribute('nav-open');
  const label = open ? 'close navigation' : 'open navigation';
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', label);
  const icon = button.querySelector('wa-icon');
  icon?.setAttribute('name', open ? 'xmark' : 'bars');
  icon?.setAttribute('label', label);
}

/** A 401 means already signed out: /login either way. */
async function signOut(base: string): Promise<void> {
  try {
    await fetch(`${base}/logout`, { method: 'POST' });
  } catch {
    toastError('network error — try again');
    return;
  }
  location.href = `${base}/login`;
}

class AppsMenu {
  private readonly status: HTMLElement | null;
  private readonly divider: Element | null;
  private readonly template: HTMLTemplateElement | null;
  private readonly logsAuto: boolean;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly dropdown: Element,
    private readonly base: string,
  ) {
    this.status = dropdown.querySelector('.apps-status');
    this.divider = dropdown.querySelector(':scope > wa-divider');
    this.template = dropdown.querySelector('template[data-app-item]');
    this.logsAuto = host.hasAttribute('data-logs-auto');
  }

  refresh(): Promise<void> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    const state = await fetchMenuState(this.base);
    if (state === 'signed-out') {
      this.showStatus('signed out');
      return;
    }
    if (state === null) {
      this.showStatus('could not load apps');
      return;
    }
    if (this.logsAuto) this.host.querySelector('#nav-logs')?.toggleAttribute('hidden', !state.logs);
    const entries = appMenuEntries(state.apps, this.base);
    this.stamp(entries);
    if (entries.length === 0) this.showStatus('no apps yet');
    else this.status?.toggleAttribute('hidden', true);
  }

  private showStatus(text: string): void {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.toggleAttribute('hidden', false);
  }

  /** Restamped whole each load: the items hold no state of their own. */
  private stamp(entries: AppMenuEntry[]): void {
    for (const old of this.dropdown.querySelectorAll(':scope > .app-item')) old.remove();
    if (!this.template) return;
    for (const entry of entries) {
      const fragment = this.template.content.cloneNode(true) as DocumentFragment;
      const item = fragment.querySelector<HTMLElement>('.app-item');
      if (!item) continue;
      item.dataset.slug = entry.slug;
      item.dataset.href = entry.href;
      item.querySelector('wa-icon')?.setAttribute('name', entry.icon);
      const name = item.querySelector('.app-name');
      if (name) name.textContent = entry.name;
      if (entry.serving) item.querySelector('.app-off')?.remove();
      else item.toggleAttribute('disabled', true);
      this.dropdown.insertBefore(fragment, this.divider);
    }
  }
}

// Last: an element already in the document connects during define(), and
// its setup needs everything above.
defineElement('app-header', host => {
  const base = host.dataset.base ?? '';
  const teardown = new AbortController();
  const { signal } = teardown;

  // Both menus' items: a data-href navigates, sign-out signs out.
  host.addEventListener(
    'wa-select',
    e => {
      const item = (e as WaSelectEvent).detail.item;
      if (item.id === 'sign-out') void signOut(base);
      else if (item.dataset.href) location.href = item.dataset.href;
    },
    { signal },
  );

  // The drawer toggle's disclosure semantics follow wa-page's nav-open,
  // whichever way it flipped (toggle, light-dismiss, Escape).
  const page = host.closest('wa-page');
  // SideNav's sign-out sits in the page's navigation footer, outside the bar.
  page?.addEventListener(
    'click',
    e => {
      const link = (e.target as Element).closest('[data-sign-out]');
      if (!link) return;
      e.preventDefault();
      void signOut(base);
    },
    { signal },
  );
  const toggle = host.querySelector('#nav-drawer-toggle');
  let navObserver: MutationObserver | null = null;
  if (page && toggle) {
    navObserver = new MutationObserver(() => syncNavToggle(page, toggle));
    navObserver.observe(page, { attributeFilter: ['nav-open'] });
  }

  const dropdown = host.querySelector('wa-dropdown.apps-menu');
  if (dropdown) {
    const menu = new AppsMenu(host, dropdown, base);
    void menu.refresh();
    // Refreshed on every open: the list is only ever looked at then.
    dropdown.addEventListener('wa-show', () => void menu.refresh(), { signal });
  }

  return () => {
    teardown.abort();
    navObserver?.disconnect();
  };
});
