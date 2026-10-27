// <app-settings>: the per-app settings page's client half. The icon grid
// (one button per registry name; the picked one is aria-checked), the
// wa-input prefill (value is a property the server can't render), and the
// save through PATCH /api/apps/<slug> — the same rename service the console
// uses. Field errors land in the hint slots like the enhancer's own; the
// domain codes the form can't predict (a bad icon, a vanished row) land in
// the result callout.
import { BASE } from '../../base';
import { isAppIcon } from '../../lib/apps/app-icons';
import { appSettingsForm } from '../../schemas/api';
import { signedInFetch } from '../signed-in-fetch';
import 'validation-enhancer/zod';
import type { ValidationEnhancerZod } from 'validation-enhancer/zod';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';

interface WaInputLike extends HTMLElement {
  value: string | null;
  setCustomValidity(message: string): void;
}

type WaCallout = HTMLElement & { variant?: string; open?: boolean };

export class AppSettings extends HTMLElement {
  private icon = '';
  /** Resolves once the enhancer holds the schema; a save clicked before
   *  then defers its submit, so validation is never skipped. The enhancer
   *  wraps the form, so it is queried directly, not under the form. */
  private readonly schemaReady: Promise<void> = customElements
    .whenDefined('validation-enhancer-zod')
    .then(() => {
      const enhancer = this.querySelector(
        'validation-enhancer-zod',
      ) as ValidationEnhancerZod | null;
      if (enhancer) enhancer.setZodSchema(appSettingsForm);
    });

  connectedCallback(): void {
    const source = this.querySelector('#app-settings-prefill') as HTMLElement | null;
    if (!source) return; // the 404 body has nothing to wire
    this.icon = source.dataset.icon ?? '';
    // The save button sits outside its form; requestSubmit so the enhancer
    // validates first.
    const form = this.querySelector('#app-settings-form') as HTMLFormElement | null;
    (this.querySelector('#app-settings-save') as HTMLElement | null)?.addEventListener(
      'click',
      () => void this.schemaReady.then(() => form?.requestSubmit()),
    );
    // Above the enhancer: it stops invalid submits from propagating.
    this.addEventListener('submit', e => {
      if ((e.target as HTMLElement).id !== 'app-settings-form') return;
      e.preventDefault();
      void this.save();
    });
    // The icon grid: delegated, so the poll-less page needs no re-wiring.
    this.querySelector('.icon-grid')?.addEventListener('click', e => {
      const pick = (e.target as HTMLElement).closest<HTMLElement>('.icon-choice');
      if (!pick) return;
      this.setIcon(pick.dataset.icon ?? '');
    });
    void customElements.whenDefined('wa-input').then(() => this.prefill());
    // A blocked submit leaves setCustomValidity on the host; clear it on
    // every edit or requestSubmit silently refuses.
    for (const name of ['name', 'cwd'] as const) {
      this.field(name)?.addEventListener('input', function (this: WaInputLike) {
        this.setCustomValidity('');
      });
    }
  }

  private slug(): string {
    return (this.querySelector('#app-settings-prefill') as HTMLElement)?.dataset.slug ?? '';
  }

  private field(name: 'name' | 'cwd'): WaInputLike | null {
    return this.querySelector(`wa-input[name="${name}"]`);
  }

  private errorTarget(name: 'name' | 'cwd'): HTMLElement | null {
    const control = this.field(name);
    const id = control?.getAttribute('aria-errormessage');
    return id ? this.querySelector(`#${CSS.escape(id)}`) : null;
  }

  private prefill(): void {
    const source = this.querySelector('#app-settings-prefill') as HTMLElement | null;
    if (!source) return;
    const name = this.field('name');
    const cwd = this.field('cwd');
    if (name) name.value = source.dataset.name ?? '';
    if (cwd) cwd.value = source.dataset.cwd ?? '';
    this.setIcon(source.dataset.icon ?? '');
  }

  private setIcon(icon: string): void {
    if (!isAppIcon(icon)) return;
    this.icon = icon;
    this.querySelectorAll<HTMLElement>('.icon-choice').forEach(btn => {
      btn.setAttribute('aria-checked', btn.dataset.icon === icon ? 'true' : 'false');
    });
  }

  private clearErrors(): void {
    for (const name of ['name', 'cwd'] as const) {
      const control = this.field(name);
      if (!control) continue;
      control.setCustomValidity('');
      control.classList.remove('valid', 'invalid');
      control.removeAttribute('aria-invalid');
      const message = this.errorTarget(name);
      if (message) message.textContent = '';
    }
    this.callout(null);
  }

  /** The custom validity clears once the user edits and the enhancer re-validates. */
  private showFieldError(name: 'name' | 'cwd', text: string): void {
    const control = this.field(name);
    if (!control) return;
    control.setCustomValidity(text);
    control.classList.add('invalid');
    control.setAttribute('aria-invalid', 'true');
    const message = this.errorTarget(name);
    if (message) message.textContent = text;
  }

  private callout(text: string | null, variant = 'danger'): void {
    const el = this.querySelector('#app-settings-result') as WaCallout | null;
    if (!el) return;
    if (text === null) {
      el.classList.add('hidden');
      return;
    }
    el.variant = variant;
    el.textContent = text;
    el.classList.remove('hidden');
  }

  private async save(): Promise<void> {
    const name = (this.field('name')?.value ?? '').trim();
    const typed = (this.field('cwd')?.value ?? '').trim();
    this.clearErrors();
    const sent = await signedInFetch(`${BASE}/api/apps/${encodeURIComponent(this.slug())}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // An empty cwd is a clear (null), not a keep — the hint promises
      // “empty = the server default”, and absent-keeps would silently no-op.
      body: JSON.stringify({ name, icon: this.icon, cwd: typed === '' ? null : typed }),
    });
    // Signed out: the page is already heading to /login.
    if (!sent.ok) return;
    const r = sent.data.response;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed body, narrowed below
    const json: any = await r.json().catch(() => null);
    if (!r.ok) {
      if (json?.code === 'invalid_name') this.showFieldError('name', json.error);
      else if (json?.code === 'invalid_cwd') this.showFieldError('cwd', json.error);
      else this.callout(json?.error ?? 'could not save — try again');
      return;
    }
    // Keep the page honest about what's now persisted: the prefill source,
    // the header, and the grid agree with the row.
    const source = this.querySelector('#app-settings-prefill') as HTMLElement | null;
    if (source) {
      source.dataset.name = name;
      source.dataset.cwd = typed;
      source.dataset.icon = this.icon;
    }
    const titleName = this.querySelector('#app-settings-title-name') as HTMLElement | null;
    if (titleName) titleName.textContent = name;
    const titleIcon = this.querySelector('#app-settings-title-icon');
    titleIcon?.setAttribute('name', this.icon);
    this.callout('saved — the sidebar shows it on its next sync', 'success');
  }
}

if (!customElements.get('app-settings')) customElements.define('app-settings', AppSettings);
