// <side-nav>: SideNav's trees. Each item's row is a link; the tree owns
// focus and selection, so Enter/Space and a click beside the link follow
// it here. The apps tree's items are stamped from GET /api/state on
// connect.
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tree/tree.js';
import '@awesome.me/webawesome/dist/components/tree-item/tree-item.js';
import { defineElement } from '../../element';
import { appMenuEntries, type AppMenuEntry } from '../../app-menu';
import { fetchMenuState } from './menu-state';

/** Restamped whole each load: the items hold no state of their own. */
function stamp(
  tree: Element,
  template: HTMLTemplateElement,
  entries: AppMenuEntry[],
  here: string,
): void {
  for (const old of tree.querySelectorAll(':scope > .app-item')) old.remove();
  const anchor = tree.querySelector(':scope > .apps-status');
  for (const entry of entries) {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const item = fragment.querySelector<HTMLElement>('.app-item');
    if (!item) continue;
    item.dataset.slug = entry.slug;
    const icon = item.querySelector('wa-icon');
    icon?.setAttribute('name', entry.icon);
    // The disabled look is the visible cue; the name says why.
    icon?.setAttribute('label', entry.serving ? entry.name : `${entry.name} (not serving)`);
    const name = item.querySelector('.app-name');
    if (name) name.textContent = entry.name;
    // No href, no link: a stopped app's row goes nowhere.
    if (entry.serving) item.querySelector('a')?.setAttribute('href', entry.href);
    else item.toggleAttribute('disabled', true);
    if (here.startsWith(entry.href)) item.toggleAttribute('selected', true);
    tree.insertBefore(fragment, anchor);
  }
}

defineElement('side-nav', host => {
  const base = host.dataset.base ?? '';
  const apps = host.querySelector('wa-tree.side-nav-apps');
  const status = host.querySelector<HTMLElement>('.apps-status');
  const template = host.querySelector<HTMLTemplateElement>('template[data-app-item]');
  if (!apps || !status || !template) return undefined;
  const teardown = new AbortController();

  const showStatus = (text: string | null): void => {
    status.textContent = text ?? '';
    status.toggleAttribute('hidden', text === null);
  };
  void (async () => {
    const state = await fetchMenuState(base);
    if (state === 'signed-out') return showStatus('signed out');
    if (state === null) return showStatus('could not load apps');
    const entries = appMenuEntries(state.apps, base);
    stamp(apps, template, entries, location.pathname);
    showStatus(entries.length === 0 ? 'no apps yet' : null);
  })();
  const follow = (target: EventTarget | null): boolean => {
    const item = (target as Element).closest('wa-tree-item');
    const link = item?.querySelector<HTMLAnchorElement>(':scope > .side-nav-row[href]');
    if (!item || item.hasAttribute('disabled') || !link) return false;
    link.click();
    return true;
  };
  host.addEventListener(
    'click',
    e => {
      if (!(e.target as Element).closest('a')) follow(e.target);
    },
    { signal: teardown.signal },
  );
  host.addEventListener(
    'keydown',
    e => {
      if ((e.key === 'Enter' || e.key === ' ') && follow(e.target)) e.preventDefault();
    },
    { signal: teardown.signal },
  );
  return () => teardown.abort();
});
