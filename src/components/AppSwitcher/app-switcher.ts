// <app-switcher>: the enhancer for AppSwitcher.astro — one checkable item
// per app (registered apps in console order, then unregistered trees,
// disabled: they have no row to hold a workspace), each with its lifecycle
// chip once /api/apps/status has answered. The current app's actions (open,
// settings, delete) follow the divider. A render that lands while the menu
// is open waits for it to close, so a push never restamps under the pointer.
//
// Emits (bubbling, handled by <console-app>): select-app {appId}, new-app,
// delete-app {slug, name}.
import type { AppServingState } from '../../lib/platform/types';
import type { AppStatusEntry, AppsStatusData } from '../../lib/apps/apps-status';
import type { AppId } from '@cybermole/app-kit';
import { BASE } from '../../base';
import { DEFAULT_APP_ICON } from '../../lib/apps/app-icons';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

export interface AppSwitcherView {
  apps: AppServingState[];
  /** null until the first /api/apps/status poll lands: no chips yet. */
  status: AppsStatusData | null;
  selected: AppId | null;
}

type Chip = { label: string; variant: string };

/** The portfolio's four states (no tree yet reads as registered too). */
export function lifecycleChip(entry: AppStatusEntry): Chip {
  if (!entry.registered) return { label: 'unregistered tree', variant: 'warning' };
  if (!entry.hasManifest || !entry.built) return { label: 'registered', variant: 'neutral' };
  if (entry.buildStale) return { label: 'stale build', variant: 'warning' };
  return { label: 'built', variant: 'success' };
}

const APP_VALUE_PREFIX = 'app:';

export class AppSwitcher extends HTMLElement {
  private view: AppSwitcherView = { apps: [], status: null, selected: null };
  /** Set while the menu is open and a render arrived. */
  private deferred = false;

  connectedCallback(): void {
    if (this.dataset.wired) return;
    this.dataset.wired = '';
    this.addEventListener('wa-select', e => this.onSelect(e));
    // The tooltip's wa-after-hide bubbles here too: only the menu's counts.
    this.addEventListener('wa-after-hide', () => {
      if (!this.deferred || this.menu()?.hasAttribute('open')) return;
      this.deferred = false;
      this.apply();
    });
  }

  render(view: AppSwitcherView): void {
    this.view = view;
    if (this.menu()?.hasAttribute('open')) this.deferred = true;
    else this.apply();
  }

  private menu(): HTMLElement | null {
    return this.querySelector('wa-dropdown');
  }

  private current(): AppServingState | null {
    return this.view.apps.find(a => a.id === this.view.selected) ?? null;
  }

  private apply(): void {
    const menu = this.menu();
    const empty = this.querySelector<HTMLElement>('.apps-empty');
    if (!menu || !empty) return;
    for (const el of menu.querySelectorAll(':scope > .app-item')) el.remove();
    const entries = new Map((this.view.status?.apps ?? []).map(e => [e.slug, e] as const));
    const apps = [...this.view.apps].sort((a, b) => a.order - b.order);
    for (const app of apps) {
      const entry = entries.get(app.slug) ?? null;
      const item = this.item(app.slug, app.name, app.icon, entry);
      item.setAttribute('value', `${APP_VALUE_PREFIX}${app.id}`);
      item.toggleAttribute('checked', app.id === this.view.selected);
      menu.insertBefore(item, empty);
    }
    const rows = new Set<string>(apps.map(a => a.slug));
    for (const entry of entries.values()) {
      if (entry.registered || rows.has(entry.slug)) continue;
      const item = this.item(
        entry.slug,
        entry.name ?? entry.slug,
        entry.icon ?? DEFAULT_APP_ICON,
        entry,
      );
      item.setAttribute('disabled', '');
      menu.insertBefore(item, empty);
    }
    empty.hidden = apps.length > 0 || menu.querySelector(':scope > .app-item') !== null;

    const app = this.current();
    const name = app?.name ?? null;
    this.querySelector('.app-switch-icon')?.setAttribute('name', app?.icon ?? 'cubes');
    this.querySelector('.app-switch-icon')?.setAttribute(
      'label',
      name === null ? 'switch app' : `switch app (current: ${name})`,
    );
    const tip = this.querySelector('.app-switch-tip');
    if (tip) tip.textContent = name === null ? 'switch app' : `${name} — switch app`;
    for (const cls of ['app-open', 'app-settings', 'app-delete']) {
      const el = this.querySelector<HTMLElement>(`.${cls}`);
      if (el) el.hidden = app === null;
    }
    if (app === null) return;
    const open = this.querySelector<HTMLElement>('.app-open');
    open?.setAttribute('href', `${BASE}/apps/${app.slug}/`);
    this.setText(
      '.app-open-label',
      app.serving
        ? `open ${app.name}`
        : `open ${app.name} (not serving: ${app.servingReason ?? 'the app host is down'})`,
    );
    this.querySelector('.app-settings')?.setAttribute('href', `${BASE}/builder/${app.slug}`);
    this.setText('.app-settings-label', `${app.name} settings`);
    this.setText('.app-delete-label', `delete ${app.name}`);
  }

  private setText(sel: string, text: string): void {
    const el = this.querySelector(sel);
    if (el) el.textContent = text;
  }

  private item(
    slug: string,
    name: string,
    icon: string,
    entry: AppStatusEntry | null,
  ): HTMLElement {
    const tpl = this.querySelector<HTMLTemplateElement>(':scope > template[data-app-item]')!;
    const item = document.importNode(tpl.content, true).firstElementChild as HTMLElement;
    item.dataset.slug = slug;
    item.querySelector('wa-icon')?.setAttribute('name', icon);
    item.querySelector('.app-item-name')!.textContent = name;
    const badge = item.querySelector<HTMLElement>('.app-item-chip')!;
    const chip = entry === null ? null : lifecycleChip(entry);
    if (chip === null) {
      badge.remove();
    } else {
      badge.setAttribute('variant', chip.variant);
      badge.textContent = chip.label;
    }
    return item;
  }

  private onSelect(e: Event): void {
    const item = (e as CustomEvent<{ item?: HTMLElement & { checked?: boolean } }>).detail.item;
    const value = item?.getAttribute('value') ?? '';
    if (value.startsWith(APP_VALUE_PREFIX)) {
      const appId = value.slice(APP_VALUE_PREFIX.length);
      // A checkable item flips on select; the selection, not the click, owns it.
      if (item) item.checked = appId === this.view.selected;
      this.emit('select-app', { appId });
    } else if (value === 'new-app') {
      this.emit('new-app', {});
    } else if (value === 'delete-app') {
      const app = this.current();
      if (app) this.emit('delete-app', { slug: app.slug, name: app.name });
    }
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

if (!customElements.get('app-switcher')) customElements.define('app-switcher', AppSwitcher);
