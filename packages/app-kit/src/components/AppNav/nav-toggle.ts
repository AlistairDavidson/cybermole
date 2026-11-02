// <nav-toggle>: NavToggle's two buttons. The desktop one hides the
// navigation column (data-nav-collapsed on the wa-page; app-nav.css owns
// the look), remembered in localStorage; the mobile one is wa-page's own
// drawer toggle, whose disclosure semantics follow nav-open here.
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { defineElement } from '../../element';

/** Shared by every page on the console's origin, apps included. */
const COLLAPSED_KEY = 'cybermole:sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function label(button: Element, text: string): void {
  button.setAttribute('aria-label', text);
  button.querySelector('wa-icon')?.setAttribute('label', text);
}

defineElement('nav-toggle', host => {
  const page = host.closest('wa-page');
  const collapse = host.querySelector('#nav-collapse');
  const drawer = host.querySelector('#nav-drawer-toggle');
  if (!page || !collapse || !drawer) return undefined;
  const teardown = new AbortController();

  let collapsed = readCollapsed();
  const applyCollapsed = (): void => {
    page.toggleAttribute('data-nav-collapsed', collapsed);
    collapse.setAttribute('aria-expanded', String(!collapsed));
    label(collapse, collapsed ? 'show the sidebar' : 'hide the sidebar');
  };
  applyCollapsed();
  collapse.addEventListener(
    'click',
    () => {
      collapsed = !collapsed;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(collapsed));
      } catch {
        /* storage unavailable — this page load only */
      }
      applyCollapsed();
    },
    { signal: teardown.signal },
  );

  // Whichever way nav-open flipped (toggle, light-dismiss, Escape).
  const syncDrawer = (): void => {
    const open = page.hasAttribute('nav-open');
    drawer.setAttribute('aria-expanded', String(open));
    drawer.querySelector('wa-icon')?.setAttribute('name', open ? 'xmark' : 'bars');
    label(drawer, open ? 'close navigation' : 'open navigation');
  };
  const observer = new MutationObserver(syncDrawer);
  observer.observe(page, { attributeFilter: ['nav-open'] });

  return () => {
    teardown.abort();
    observer.disconnect();
  };
});
