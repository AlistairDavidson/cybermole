// <settings-app>: wires the server-rendered /settings actions (pi update,
// auto-update toggle, terminal defaults, log out everywhere), then refreshes
// [data-refresh] regions from /partials/settings. Those regions hold no wa-*,
// so nothing needs re-hydrating.
import type { UpdateResult } from '../../lib/platform/types';
import { BASE } from '../../base';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
import 'validation-enhancer/zod';
import type { ValidationEnhancerZod } from 'validation-enhancer/zod';
import { terminalDefaultsBody } from '../../schemas/api';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
// Needed client-side too, or the SSR'd wa-inputs never upgrade (AGENTS.md).
import '@awesome.me/webawesome/dist/components/input/input.js';

interface WaButtonLike extends HTMLElement {
  loading: boolean;
  disabled: boolean;
}
interface WaCalloutLike extends HTMLElement {
  variant: string;
}
interface WaDetailsLike extends HTMLElement {
  open: boolean;
}
interface WaSwitchLike extends HTMLElement {
  checked: boolean;
  disabled: boolean;
}
/** An empty wa-input's value is null, not ''; both mean clear. */
interface WaInputLike extends HTMLElement {
  value: string | null;
  name: string;
  setCustomValidity(message: string): void;
}

export class SettingsApp extends HTMLElement {
  private $<T extends HTMLElement>(id: string): T {
    return this.querySelector(`#${id}`) as T;
  }

  connectedCallback(): void {
    this.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest('wa-button');
      if (button?.id === 'update-pi') void this.updatePi();
      else if (button?.id === 'logout-all') void this.logoutAll();
    });
    // Click handlers on the buttons themselves: inside the form, a native
    // submit would race the validated one. Save requestSubmits so the
    // enhancer validates first.
    (this.querySelector('#save-terminal-defaults') as HTMLElement | null)?.addEventListener(
      'click',
      () => this.defaultsForm()?.requestSubmit(),
    );
    (this.querySelector('#reset-terminal-defaults') as HTMLElement | null)?.addEventListener(
      'click',
      () => void this.resetDefaults(),
    );
    this.addEventListener('change', e => {
      if ((e.target as HTMLElement).id === 'pi-auto-update') void this.toggleAutoUpdate();
    });
    // Above the enhancer: it stops invalid submits, and a listener on the
    // form itself would fire before validation.
    this.addEventListener('submit', e => {
      if ((e.target as HTMLElement).id !== 'terminal-defaults-form') return;
      e.preventDefault();
      void this.saveDefaults();
    });
    // wa-input's value is a property the server can't render, so prefill
    // once it has upgraded.
    void customElements
      .whenDefined('validation-enhancer-zod')
      .then(() =>
        (this.querySelector('validation-enhancer-zod') as ValidationEnhancerZod).setZodSchema(
          terminalDefaultsBody,
        ),
      );
    void customElements.whenDefined('wa-input').then(() => this.prefillDefaults());
    // A blocked submit leaves setCustomValidity on the wa-input host, and
    // requestSubmit then silently refuses. Clear it on every edit, before
    // the enhancer re-marks a still-invalid value.
    for (const name of ['agentCommand', 'shellCommand'] as const) {
      this.defaultsField(name)?.addEventListener('input', function (this: WaInputLike) {
        this.setCustomValidity('');
      });
    }
    this.localizeTimes();
  }

  // ---- terminal defaults ----

  /** What we last put in the fields, to tell user edits apart. */
  private applied: { agentCommand: string; shellCommand: string } | null = null;

  private defaultsForm(): HTMLFormElement | null {
    return this.querySelector('#terminal-defaults-form');
  }

  private defaultsField(name: 'agentCommand' | 'shellCommand'): WaInputLike | null {
    return this.querySelector(`wa-input[name="${name}"]`);
  }

  private defaultsError(control: WaInputLike): HTMLElement | null {
    const id = control.getAttribute('aria-errormessage');
    return id ? this.querySelector(`#${CSS.escape(id)}`) : null;
  }

  private clearDefaultsErrors(): void {
    for (const name of ['agentCommand', 'shellCommand'] as const) {
      const control = this.defaultsField(name);
      if (!control) continue;
      control.setCustomValidity('');
      control.classList.remove('valid', 'invalid');
      control.removeAttribute('aria-invalid');
      const message = this.defaultsError(control);
      if (message) message.textContent = '';
    }
  }

  /** The custom validity clears once the user edits and the enhancer re-validates. */
  private showDefaultsErrors(issues: Record<string, string>): void {
    for (const [name, text] of Object.entries(issues)) {
      const control = this.defaultsField(name as 'agentCommand' | 'shellCommand');
      if (!control) continue;
      control.setCustomValidity(text);
      control.classList.add('invalid');
      control.setAttribute('aria-invalid', 'true');
      const message = this.defaultsError(control);
      if (message) message.textContent = text;
    }
  }

  /** Fill the fields with the server's effective values, but never over a
   *  field the user edited since we last filled it (a refresh can land
   *  mid-typing). */
  private prefillDefaults(): void {
    const source = this.$('terminal-defaults-source');
    const agent = this.defaultsField('agentCommand');
    const shell = this.defaultsField('shellCommand');
    if (!source || !agent || !shell) return;
    const next = {
      agentCommand: source.dataset.agentCommand ?? '',
      shellCommand: source.dataset.shellCommand ?? '',
    };
    const apply = (
      control: WaInputLike,
      name: 'agentCommand' | 'shellCommand',
      value: string,
    ): void => {
      const before = this.applied;
      const edited = before !== null && (control.value ?? '') !== before[name];
      if (!edited) control.value = value;
    };
    apply(agent, 'agentCommand', next.agentCommand);
    apply(shell, 'shellCommand', next.shellCommand);
    this.applied = next;
  }

  private defaultsCallout(): WaCalloutLike {
    return this.$('terminal-defaults-result');
  }

  private async saveDefaults(): Promise<void> {
    const result = this.defaultsCallout();
    const agent = this.defaultsField('agentCommand');
    const shell = this.defaultsField('shellCommand');
    if (!agent || !shell) return;
    result.classList.add('hidden');
    // An emptied field is null (or ''); the schema turns either into a clear.
    const sent = await signedInFetch(`${BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentCommand: agent.value ?? null,
        shellCommand: shell.value ?? null,
      }),
    });
    if (!sent.ok) {
      this.notAnswered(result, sent, 'could not save the terminal defaults');
      return;
    }
    const res = sent.data.response;
    const body = (await res.json().catch(() => null)) as {
      agentCommand?: string;
      shellCommand?: string;
      issues?: Record<string, string>;
      error?: string;
    } | null;
    if (!res.ok) {
      if (body?.issues) this.showDefaultsErrors(body.issues);
      this.showError(result, body?.error ?? `could not save (HTTP ${res.status})`);
      return;
    }
    this.clearDefaultsErrors();
    result.variant = 'success';
    result.textContent = 'saved — the next terminal runs it';
    result.classList.remove('hidden');
    // The fields now hold what the server reports, so the refresh's prefill
    // only skips a field edited mid-flight.
    this.applied = { agentCommand: agent.value ?? '', shellCommand: shell.value ?? '' };
    void this.refresh();
  }

  private async resetDefaults(): Promise<void> {
    const result = this.defaultsCallout();
    result.classList.add('hidden');
    const sent = await signedInFetch(`${BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentCommand: null, shellCommand: null }),
    });
    if (!sent.ok) {
      this.notAnswered(result, sent, 'could not reset the terminal defaults');
      return;
    }
    const res = sent.data.response;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      this.showError(result, body.error ?? `could not reset (HTTP ${res.status})`);
      return;
    }
    result.variant = 'success';
    result.textContent = 'back to the defaults (env / built-in chain)';
    result.classList.remove('hidden');
    this.applied = null; // refill both fields from the server
    void this.refresh();
  }

  /** Show server ISO times in the browser's locale. */
  private localizeTimes(): void {
    this.querySelectorAll<HTMLTimeElement>('time[datetime]').forEach(t => {
      t.textContent = new Date(t.dateTime).toLocaleString();
    });
  }

  private showError(callout: WaCalloutLike, message: string): void {
    callout.variant = 'danger';
    callout.textContent = message;
    callout.classList.remove('hidden');
  }

  /** Signed out shows nothing: the page is already heading to /login. */
  private notAnswered(
    callout: WaCalloutLike,
    failure: SignedInFetchFailure,
    prefix = 'request failed',
  ): void {
    switch (failure.errorCode) {
      case 'signed_out':
        return;
      case 'network_error':
        this.showError(callout, `${prefix}: ${failure.errorMessage ?? 'network error'}`);
        return;
      default:
        return failure satisfies never;
    }
  }

  private async refresh(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/partials/settings`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (!r.ok) return;
    const fresh = new DOMParser().parseFromString(await r.text(), 'text/html');
    fresh.querySelectorAll<HTMLElement>('[data-refresh][id]').forEach(region => {
      this.querySelector(`#${CSS.escape(region.id)}`)?.replaceWith(
        document.importNode(region, true),
      );
    });
    this.localizeTimes();
    this.prefillDefaults();
    const flags = this.$('pi-flags').dataset;
    const npmAvailable = flags.npmAvailable === 'true';
    this.$<WaButtonLike>('update-pi').disabled = !npmAvailable;
    const autoSwitch = this.$<WaSwitchLike>('pi-auto-update');
    autoSwitch.checked = flags.autoEnabled === 'true';
    autoSwitch.disabled = !npmAvailable;
    this.$('auto-update-output').classList.toggle(
      'hidden',
      !this.$('auto-update-output-text').textContent,
    );
  }

  private npmAvailable(): boolean {
    return this.$('pi-flags').dataset.npmAvailable === 'true';
  }

  private async updatePi(): Promise<void> {
    const updateBtn = this.$<WaButtonLike>('update-pi');
    const result = this.$<WaCalloutLike>('update-result');
    const outputWrap = this.$<WaDetailsLike>('update-output');
    const output = outputWrap.querySelector('pre')!;
    if (updateBtn.disabled) return;
    updateBtn.loading = true;
    updateBtn.disabled = true;
    result.classList.add('hidden');
    outputWrap.classList.add('hidden');
    try {
      const sent = await signedInFetch(`${BASE}/api/update-pi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!sent.ok) {
        this.notAnswered(result, sent);
        return;
      }
      const res = sent.data.response;
      // null: not an UpdateResult (e.g. a proxy's error page).
      const r = (await res.json().catch(() => null)) as UpdateResult | null;
      if (r === null) {
        result.variant = 'danger';
        result.textContent = `update failed (HTTP ${res.status})`;
      } else if (r.ok && !r.dryRun && r.after !== r.before) {
        result.variant = 'success';
        result.textContent = `updated pi ${r.before ?? 'not installed'} → ${r.after ?? 'not installed'} — new sessions use it`;
        void this.refresh(); // npm may have re-pinned the declared range
      } else if (r.ok) {
        result.variant = 'success';
        result.textContent = `pi ${r.after ?? 'not installed'} is already installed — no change`;
      } else {
        result.variant = 'danger';
        result.textContent = r.error ?? `update failed (HTTP ${res.status})`;
      }
      if (r?.output) {
        output.textContent = r.output;
        outputWrap.open = true;
        outputWrap.classList.remove('hidden');
      }
      result.classList.remove('hidden');
    } finally {
      updateBtn.loading = false;
      updateBtn.disabled = !this.npmAvailable();
    }
  }

  // Applies immediately; reverts the switch if the save fails.
  private async toggleAutoUpdate(): Promise<void> {
    const autoSwitch = this.$<WaSwitchLike>('pi-auto-update');
    const autoResult = this.$<WaCalloutLike>('auto-result');
    const enabled = autoSwitch.checked;
    autoSwitch.disabled = true;
    autoResult.classList.add('hidden');
    try {
      const sent = await signedInFetch(`${BASE}/api/auto-update-pi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (sent.ok && sent.data.response.ok) {
        if (enabled)
          this.$('auto-check-line').textContent = 'not checked yet — first check within a minute';
        return;
      }
      autoSwitch.checked = !enabled;
      if (!sent.ok) this.notAnswered(autoResult, sent, 'could not save the setting');
      else
        this.showError(autoResult, `could not save the setting: HTTP ${sent.data.response.status}`);
    } finally {
      autoSwitch.disabled = false;
    }
  }

  // Other browsers find out on their next request or terminal message.
  private async logoutAll(): Promise<void> {
    const logoutAllBtn = this.$<WaButtonLike>('logout-all');
    const logoutResult = this.$<WaCalloutLike>('logout-result');
    if (logoutAllBtn.disabled) return;
    logoutAllBtn.loading = true;
    logoutAllBtn.disabled = true;
    logoutResult.classList.add('hidden');
    try {
      const sent = await signedInFetch(`${BASE}/api/logout-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      // signed_out: already expired elsewhere.
      if (!sent.ok) {
        this.notAnswered(logoutResult, sent);
        return;
      }
      const res = sent.data.response;
      if (res.ok) {
        location.href = `${BASE}/login`;
        return;
      }
      this.showError(logoutResult, `log out everywhere failed (HTTP ${res.status})`);
    } finally {
      logoutAllBtn.loading = false;
      logoutAllBtn.disabled = false;
    }
  }
}

if (!customElements.get('settings-app')) customElements.define('settings-app', SettingsApp);
