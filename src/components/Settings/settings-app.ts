// settings-app.ts — <settings-app>: enhances the server-rendered /settings
// dashboard (SettingsView.astro). Data arrives as HTML; this element only
// wires the actions — the manual pi update (POST /api/update-pi), the
// auto-update toggle (POST /api/auto-update-pi), log out everywhere — and,
// after an update, refreshes the data regions from /partials/settings
// (swapping the [data-refresh] elements by id: plain HTML, no wa-*
// inside, so nothing re-hydrates). Events are delegated to this element.
import type { UpdateResult } from '../../lib/platform/types';
import { BASE } from '../../base';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
// Registers <validation-enhancer-zod> (and the base <validation-enhancer>).
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
// The terminal-defaults form's SSR'd controls (AGENTS.md: SSR imports ≠
// client imports — without this the wa-inputs never upgrade, and a wa-*
// form that hasn't upgraded submits none of its values).
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
/** wa-input's surface for the terminal-defaults fields. An empty
 *  wa-input's value is null, not '' — and either way the payload means
 *  CLEAR: the schema normalizes '' to null (validation-enhancer-zod
 *  feeds an emptied field as ''). */
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
    // The terminal-defaults buttons: direct onclick on the hosts
    //  (jobs-app's #job-save pattern — they live inside the form, where a
    //  native submit default action would race the validated submit).
    //  The save button requestSubmits so validation-enhancer-zod runs
    //  first (the AGENTS.md rule); the reset posts its explicit nulls.
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
    // Valid submits only (task/defaults-settings): the enhancer stops an
    // invalid one from propagating, so this listener sits ABOVE it — a
    // listener on the form itself would fire (target phase) before
    // validation ran.
    this.addEventListener('submit', e => {
      if ((e.target as HTMLElement).id !== 'terminal-defaults-form') return;
      e.preventDefault();
      void this.saveDefaults();
    });
    // The form validates against the same schema POST /api/settings parses
    // with; the fields prefill from the source region's data (the effective
    // values — wa-input's value is a property, so the server render can't
    // set it and the prefill runs once the control has upgraded).
    void customElements
      .whenDefined('validation-enhancer-zod')
      .then(() =>
        (this.querySelector('validation-enhancer-zod') as ValidationEnhancerZod).setZodSchema(
          terminalDefaultsBody,
        ),
      );
    void customElements.whenDefined('wa-input').then(() => this.prefillDefaults());
    // A blocked submit leaves the zod layer's setCustomValidity on the
    //  wa-input HOST (the inner input's own state clears on edit; the
    //  host's does not) — and requestSubmit's interactive validation
    //  consults the host, silently refusing to submit at all. Clear the
    //  stale flag on every edit (observed here, on the host — before the
    //  enhancer's ancestor listener re-marks a still-invalid value, so a
    //  zod error keeps showing while it should).
    for (const name of ['agentCommand', 'shellCommand'] as const) {
      this.defaultsField(name)?.addEventListener('input', function (this: WaInputLike) {
        this.setCustomValidity('');
      });
    }
    this.localizeTimes();
  }

  // ---- terminal defaults (task/defaults-settings) ----

  /** The effective values this element last applied to the fields — the
   *  edit-detector prefillDefaults() skips changed fields against. */
  private applied: { agentCommand: string; shellCommand: string } | null = null;

  private defaultsForm(): HTMLFormElement | null {
    return this.querySelector('#terminal-defaults-form');
  }

  private defaultsField(name: 'agentCommand' | 'shellCommand'): WaInputLike | null {
    return this.querySelector(`wa-input[name="${name}"]`);
  }

  /** The field's message element (its hint slot — WaField). */
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

  /** A 400's per-field issues, in the fields' hint slots (jobs-app's
   *  showFieldErrors pattern: the custom validity clears itself once the
   *  user edits and the enhancer re-validates). */
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

  /** Fill the two fields with the server's effective values (the source
   *  region's data attributes — #terminal-defaults-source, refreshed by
   *  refresh()). Runs on load and after every save/reset — but never over
   *  a field the user has edited since: the refresh ride can land while
   *  they type, and clobbering their edit (or quietly re-saving it as the
   *  stale shown value) is the worse wrong. A field is skipped when its
   *  current value no longer equals the one WE last applied. */
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
    // An emptied field is null on an upgraded wa-input ('' once the
    //  enhancer has had it) — either way the schema's transform makes it
    //  null: the PER-FIELD clear. A too-long or multiline value never got
    //  past the enhancer.
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
    // What was sent is what the server now reports — mark the fields as
    // ours at these values, so the refresh's prefill skips only a field
    // genuinely edited while the save was in flight.
    this.applied = { agentCommand: agent.value ?? '', shellCommand: shell.value ?? '' };
    void this.refresh(); // the source line + the config row re-render server-side
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
    this.applied = null; // a reset MEANS re-filling both fields from the server
    void this.refresh();
  }

  /** Server-rendered <time> values are ISO; show them in the browser's
   *  locale and timezone. */
  private localizeTimes(): void {
    this.querySelectorAll<HTMLTimeElement>('time[datetime]').forEach(t => {
      t.textContent = new Date(t.dateTime).toLocaleString();
    });
  }

  /** An action's failure, in its callout. */
  private showError(callout: WaCalloutLike, message: string): void {
    callout.variant = 'danger';
    callout.textContent = message;
    callout.classList.remove('hidden');
  }

  /** An action whose request got no answer. Signed out shows nothing: the
   *  page is already on its way to /login. */
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

  /** Re-render the data regions from the partial and re-apply the flags. */
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
    // task/defaults-settings: the terminal-defaults fields follow the
    //  refreshed effective values (a save/reset just changed them; on a
    //  plain refresh nothing moves).
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
      // Not an UpdateResult (e.g. a proxy's error page): the status says it.
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

  // The auto-update toggle applies immediately (no form): persist via the
  // API, revert the switch when the save fails. The first check runs
  // within a minute of turning the setting on, so the status line says so.
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
      autoSwitch.checked = !enabled; // the save failed — restore what's persisted
      if (!sent.ok) this.notAnswered(autoResult, sent, 'could not save the setting');
      else
        this.showError(autoResult, `could not save the setting: HTTP ${sent.data.response.status}`);
    } finally {
      autoSwitch.disabled = false;
    }
  }

  // 'Log out everywhere': the server drops every session token and ends
  // every live terminal. This browser is sent back to the sign-in page —
  // other browsers find out on their next request (or terminal message).
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
      // signed_out = the session already expired elsewhere — back to sign-in too.
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
