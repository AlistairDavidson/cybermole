// <console-app>: drives the terminal tabs (and on the builder page the app
// switcher), the /ws/events-driven state refresh (subscribeConsoleEvents)
// and the create/delete dialogs; the tabs and the switcher only emit events.
// A page shows one workspace: scope "console" (the / page) the console's
// one, without an editor tab; "builder" (/builder) the selected app's build
// session (its operator workspace is the app page drawer's) — picked in the switcher, remembered in
// ?app=<slug> and localStorage, with lifecycle chips from the
// /api/apps/status poll. A missing one is created on sight (POST
// /api/workspaces is an ensure).
import type { AppServingState, ConsoleState, WorkspaceState } from '../../lib/platform/types';
import type { AppsStatusData } from '../../lib/apps/apps-status';
import {
  asTerminalId,
  asTmuxSessionName,
  asWorkspaceId,
  normalizeSlug,
  TMUX_SESSION_NAME_RE,
  UUID_RE,
  type AppId,
  type AppSlug,
  type TerminalId,
  type TmuxSessionName,
  type WorkspaceId,
} from '@cybermole/app-kit';
import { BASE } from '../../base';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
import { subscribeConsoleEvents } from '../console-events';
import { inTextField } from '../AgentTerminal/agent-terminal';
import type { TerminalCommand } from '../../lib/terminals/tab-order';
import 'validation-enhancer/zod';
import type { ValidationEnhancerZod } from 'validation-enhancer/zod';
import { appForm } from '../../schemas/api';
import { DEFAULT_APP_ICON, suggestAppIcon } from '../../lib/apps/app-icons';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import type { TerminalTabs } from '../TerminalTabs/terminal-tabs';
import '../TerminalTabs/terminal-tabs';
import type { AppSwitcher } from '../AppSwitcher/app-switcher';
import '../AppSwitcher/app-switcher';

type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

type WaDialog = HTMLElement & { show(): void; open: boolean };

/** An empty wa-input's value is null, not ''. */
type WaInput = HTMLElement & { value: string | null };

/** The builder page's last-selected app slug. */
const LAST_APP_KEY = 'cybermole:builder-app';

type PendingDelete =
  { kind: 'app'; slug: AppSlug; name: string } | { kind: 'terminal'; id: TerminalId; name: string };

export class ConsoleApp extends HTMLElement {
  private teardownEvents: (() => void) | null = null;
  private state: ConsoleState | null = null;
  private readonly scope: 'console' | 'builder' =
    this.getAttribute('scope') === 'builder' ? 'builder' : 'console';
  /** The builder scope's portfolio join; null until its first poll lands. */
  private appsStatus: AppsStatusData | null = null;
  /** The shown workspace: the console's, or the selected app's. */
  private selected: WorkspaceId | null = null;
  /** The builder scope's app; null with no apps (or on the console page). */
  private selectedApp: AppId | null = null;
  /** The slug to select once state lands: ?app=, else the last one. */
  private wantedSlug: string | null = (() => {
    const param = new URLSearchParams(location.search).get('app');
    if (param) return param;
    try {
      return localStorage.getItem(LAST_APP_KEY);
    } catch {
      return null;
    }
  })();
  /** Groups whose ensure is in flight (the console group is ''). */
  private readonly ensuring = new Set<string>();
  private pendingDelete: PendingDelete | null = null;
  /** Serializes reorder writes (see the reorder-terminals listener). */
  private reorderQueue: Promise<void> = Promise.resolve();
  /** True once the user hand-edits the new-app dialog's cwd: the name no
   *  longer re-suggests a directory. Reset when the dialog reopens. */
  private appCwdTouched = false;
  /** /?t=<terminal uuid>, resolved on the first state load. A dead tab still
   *  opens (the attach respawns it); an unknown uuid toasts. */
  private pendingTerminal: TerminalId | null = (() => {
    const v = new URLSearchParams(location.search).get('t') ?? '';
    return UUID_RE.test(v) ? asTerminalId(v) : null;
  })();
  /** /?run=<session>: a live job run, shown on the first state load. */
  private pendingRun: TmuxSessionName | null = (() => {
    const v = new URLSearchParams(location.search).get('run') ?? '';
    return TMUX_SESSION_NAME_RE.test(v) ? asTmuxSessionName(v) : null;
  })();
  /** Aborts the document-level listeners on disconnect. */
  private listening: AbortController | null = null;

  connectedCallback(): void {
    // The sidebar sits in wa-page's navigation slot, outside this element,
    // so the console's events are heard where they all arrive: the document.
    this.listening = new AbortController();
    const { signal } = this.listening;
    const on = (type: string, listener: (e: Event) => void): void =>
      document.addEventListener(type, listener, { signal });
    // Ids are re-checked against state anyway.
    on('select-app', e => {
      const id = (e as CustomEvent<{ appId?: string }>).detail.appId ?? '';
      const app = this.state?.apps.find(a => a.id === id);
      if (app) this.selectApp(app);
    });
    on('new-app', () => this.openAppDialog());
    on('delete-app', e => {
      const d = (e as CustomEvent<{ slug: string; name: string }>).detail;
      this.confirmDelete({ kind: 'app', slug: d.slug as AppSlug, name: d.name });
    });
    on('new-terminal', e => {
      const d = (e as CustomEvent<{ workspaceId?: string; command?: string }>).detail;
      const id = d.workspaceId ?? '';
      const command: TerminalCommand = d.command === 'agent' ? 'agent' : 'shell';
      if (UUID_RE.test(id)) void this.createTerminal(asWorkspaceId(id), command);
    });
    on('reorder-terminals', e => {
      const d = (e as CustomEvent<{ workspaceId?: string; order?: string[] }>).detail;
      const id = d.workspaceId ?? '';
      const order = (d.order ?? []).filter(x => UUID_RE.test(x));
      if (UUID_RE.test(id) && order.length > 0) {
        // Serialized, so two rapid drags write in dispatch order and the
        // newest order is what the server keeps (each write is a full list).
        const run = this.reorderQueue.then(() =>
          this.reorderTerminals(
            asWorkspaceId(id),
            order.map(x => asTerminalId(x)),
          ),
        );
        this.reorderQueue = run.then(
          () => undefined,
          () => undefined,
        );
      }
    });
    on('close-terminal', e => {
      const d = (e as CustomEvent<{ id: string }>).detail;
      const t = this.selectedWorkspace()?.terminals.find(x => x.id === d.id);
      this.confirmDelete({
        kind: 'terminal',
        id: asTerminalId(d.id),
        name: t?.title ?? d.id.slice(0, 8),
      });
    });
    // Any pane's socket closing → refresh the dots.
    on('terminal-closed', () => void this.loadState());
    // Without this, a blocked pop-up looks like a dead button.
    on('pop-blocked', () =>
      this.toast('pop-up blocked — allow pop-ups to pop a tab out', {
        variant: 'danger',
        icon: 'triangle-exclamation',
        duration: 6000,
      }),
    );

    // Footer buttons sit outside their forms; requestSubmit so the enhancer validates first.
    const appSave = this.querySelector<HTMLElement>('#app-save');
    if (appSave)
      appSave.onclick = () => (this.querySelector('#app-form') as HTMLFormElement).requestSubmit();
    (this.querySelector('#confirm-delete-ok') as HTMLElement).onclick = () => void this.runDelete();
    // The new-app dialog suggests a directory derived from the name (the
    // server's own slug rule), until the cwd is hand-edited. The icon
    // preview rides the same name typing through the shared suggestion
    // rule — the server applies it when the create carries no icon.
    const appName = this.querySelector('#app-name') as WaInput | null;
    const appCwd = this.querySelector('#app-cwd') as WaInput | null;
    if (appName && appCwd) {
      appName.addEventListener('input', () => {
        if (this.appCwdTouched) return;
        appCwd.value = this.suggestAppCwd(appName.value ?? '');
        this.updateAppIconPreview(appName.value ?? '');
      });
      appCwd.addEventListener('input', () => {
        this.appCwdTouched = true;
      });
    }
    // Above the enhancer: it stops invalid submits from propagating, and a
    // listener on the form itself would fire before validation.
    this.addEventListener('submit', e => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      if (form.id === 'app-form') void this.createApp();
    });
    void customElements.whenDefined('validation-enhancer-zod').then(() => {
      (
        this.querySelector('#app-dialog validation-enhancer-zod') as ValidationEnhancerZod
      )?.setZodSchema(appForm);
    });

    void this.loadState();
    // No poll: workspaces/apps events push the refresh, the liveness
    // watcher covers out-of-band changes, and each (re)connect re-syncs.
    this.teardownEvents = subscribeConsoleEvents({
      onEvent: () => {
        void this.loadState();
      },
      onOpen: () => {
        void this.loadState();
      },
    });
    document.addEventListener('keydown', this.onKeydown, true);
  }

  disconnectedCallback(): void {
    this.teardownEvents?.();
    this.teardownEvents = null;
    this.listening?.abort();
    this.listening = null;
    document.removeEventListener('keydown', this.onKeydown, true);
  }

  /** ctrl-t / ctrl-shift-t open shell / agent tabs in the selected
   *  workspace. Capture phase, so preventDefault beats both the browser's
   *  own binding and xterm (which skips default-prevented events). Never
   *  while typing: a focused text field, an open dialog or an open menu
   *  keeps the keys for itself. */
  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (this.selected === null) return;
    if (e.repeat) return; // a held key must not spray tabs
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 't') return;
    if (inTextField(document.activeElement)) return;
    if (document.querySelector('wa-dialog[open], wa-dropdown[open], wa-drawer[open]')) return;
    e.preventDefault();
    void this.createTerminal(this.selected, e.shiftKey ? 'agent' : 'shell');
  };

  private switcher(): AppSwitcher | null {
    return this.querySelector('app-switcher') as AppSwitcher | null;
  }

  private tabs(): TerminalTabs | null {
    return this.querySelector('terminal-tabs') as TerminalTabs | null;
  }

  private selectedWorkspace(): WorkspaceState | null {
    return this.state?.workspaces.find(w => w.id === this.selected) ?? null;
  }

  /** The group this page shows: the console's (null), or the selected app's
   *  (undefined while the builder has no app to show). */
  private shownGroup(): AppId | null | undefined {
    if (this.scope === 'console') return null;
    return this.selectedApp ?? undefined;
  }

  private selectApp(app: AppServingState): void {
    this.selectedApp = app.id;
    this.wantedSlug = null;
    try {
      localStorage.setItem(LAST_APP_KEY, app.slug);
    } catch {
      /* unusable storage: nothing is remembered */
    }
    const url = new URL(location.href);
    url.searchParams.set('app', app.slug);
    url.searchParams.delete('t');
    history.replaceState(history.state, '', url);
    this.resolveSelection();
    this.applySelection();
  }

  /** Re-derives the builder's app (kept if it still exists, else the wanted
   *  slug, else the first app) and the shown group's workspace — ensuring
   *  one when the group has none yet. */
  private resolveSelection(): void {
    const st = this.state;
    if (!st) return;
    if (this.scope === 'builder') {
      const apps = [...st.apps].sort((a, b) => a.order - b.order);
      const keep = apps.find(a => a.id === this.selectedApp);
      const wanted = apps.find(a => a.slug === this.wantedSlug);
      this.selectedApp = (keep ?? wanted ?? apps[0])?.id ?? null;
      const app = apps.find(a => a.id === this.selectedApp);
      document.title = app ? `cybermole — builder — ${app.name}` : 'cybermole — builder';
    }
    const group = this.shownGroup();
    if (group === undefined) {
      this.selected = null;
      return;
    }
    // An app's operator workspace belongs to its app page's drawer.
    const ws =
      st.workspaces.find(w => w.appId === group && (group === null || w.kind === 'build')) ?? null;
    this.selected = ws?.id ?? null;
    if (ws === null) void this.ensureWorkspace(group);
  }

  /** The shown workspace (the console's, or an app's build session),
   *  created on first sight. The server answers
   *  an existing one, so a racing tab or a stale state costs nothing. */
  private async ensureWorkspace(appId: AppId | null): Promise<void> {
    const key = appId ?? '';
    if (this.ensuring.has(key)) return;
    this.ensuring.add(key);
    try {
      const done = await this.call(
        'POST',
        '/api/workspaces',
        appId === null ? {} : { appId, kind: 'build' },
      );
      if (!done) return;
      if (!done.ok) {
        this.errorToast('could not open the workspace — try again', done.json);
        return;
      }
      await this.loadState();
    } finally {
      this.ensuring.delete(key);
    }
  }

  private dialog(sel: string): WaDialog {
    return this.querySelector(sel) as WaDialog;
  }

  private toast(message: string, options?: Record<string, unknown>): void {
    void (this.querySelector('wa-toast') as WaToast | null)?.create(message, options);
  }

  /** Signed out needs no toast: the page is already heading to /login. */
  private notAnswered(failure: SignedInFetchFailure): void {
    switch (failure.errorCode) {
      case 'signed_out':
        return;
      case 'network_error':
        this.toast('network error — try again', {
          variant: 'danger',
          icon: 'triangle-exclamation',
          duration: 6000,
        });
        return;
      default:
        return failure satisfies never;
    }
  }

  /** Error bodies are parsed and returned too. */
  private async call(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body, callers narrow it (errorToast: { error?: string })
  Promise<{ ok: boolean; status: number; json: any } | null> {
    const sent = await signedInFetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!sent.ok) {
      this.notAnswered(sent);
      return null;
    }
    const r = sent.data.response;
    const json = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, json };
  }

  private errorToast(fallback: string, json: { error?: string } | null): void {
    this.toast(json?.error ?? fallback, {
      variant: 'danger',
      icon: 'triangle-exclamation',
      duration: 6000,
    });
  }

  // ---- state refresh ----

  async loadState(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/state`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (!r.ok) return;
    const st = (await r.json()) as ConsoleState;
    this.noteNewBuildSessions(this.state, st);
    this.state = st;
    if (this.scope === 'builder') void this.loadAppsStatus();
    // Deep links are consumed in one pass, so a ?t= hit can't leave a ?run=
    // armed for the next poll.
    const pendingTerminal = this.pendingTerminal;
    const pendingRun = this.pendingRun;
    this.pendingTerminal = null;
    this.pendingRun = null;
    if (pendingRun && this.scope === 'builder') {
      // Job runs are orchestration: they live on the console page.
      location.replace(`${BASE}/?run=${encodeURIComponent(pendingRun)}`);
      return;
    }
    if (pendingTerminal) {
      const home = st.workspaces.find(w => w.terminals.some(t => t.id === pendingTerminal));
      if (home) {
        // Deep links route by owner: a build session's tab belongs on the
        // builder page, an operator workspace's on its app page (the
        // drawer), the console workspace's on the console.
        if (home.appId !== null && home.kind !== 'build') {
          const slug = st.apps.find(a => a.id === home.appId)?.slug;
          if (slug) {
            location.replace(`${BASE}/apps/${slug}/`);
            return;
          }
        }
        if (this.scope === 'console' && home.appId !== null) {
          location.replace(`${BASE}/builder?t=${pendingTerminal}`);
          return;
        }
        if (this.scope === 'builder' && home.appId === null) {
          location.replace(`${BASE}/?t=${pendingTerminal}`);
          return;
        }
        if (home.appId !== null) this.selectedApp = home.appId;
        this.resolveSelection();
        this.applySelection(pendingTerminal);
        return;
      }
      // Not ours: toast, and still land on the workspace below.
      this.toast('no such terminal', { variant: 'neutral', icon: 'circle-info', duration: 6000 });
    }
    this.resolveSelection();
    if (pendingRun) {
      this.applySelection();
      this.tabs()?.showRun(pendingRun);
      return;
    }
    this.applySelection();
  }

  /** A build session that appeared out-of-band — an agent's build_session
   *  in a terminal, another tab's builder — while this console page was
   *  open: point the human at the builder page, where it lives. Not on
   *  the builder page itself (its sidebar shows the new group directly)
   *  and not on the first load (nothing is "new"). */
  private noteNewBuildSessions(prev: ConsoleState | null, next: ConsoleState): void {
    if (prev === null || this.scope !== 'console') return;
    const known = new Set(prev.workspaces.map(w => w.id));
    const fresh = next.workspaces.filter(
      (w): w is typeof w & { appId: AppId } => w.appId !== null && !known.has(w.id),
    );
    if (fresh.length === 0) return;
    // The FRESH state's apps: the app row often lands in the same push.
    const appNames = new Map((next.apps ?? []).map(a => [a.id, a.name]));
    const label = fresh.map(w => `${appNames.get(w.appId) ?? 'an app'}: “${w.name}”`).join(', ');
    this.toast(`build session opened — ${label}. Open the builder page to watch it`, {
      variant: 'neutral',
      icon: 'cubes',
      duration: 10_000,
    });
  }

  /** The builder scope's /api/apps/status half of the poll. A failure keeps
   *  the last good list (the sidebar tolerates a null status). */
  private async loadAppsStatus(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/apps/status`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (!r.ok) return;
    this.appsStatus = (await r.json()) as AppsStatusData;
    this.applySelection();
  }

  /** initialTab (the ?t= deep link) gets the pane instead of the first tab. */
  private applySelection(initialTab?: TerminalId): void {
    const st = this.state;
    if (!st) return;
    const ws = this.selectedWorkspace();
    this.switcher()?.render({
      apps: st.apps,
      status: this.appsStatus,
      selected: this.selectedApp,
    });
    const tabs = this.tabs();
    if (!tabs) return;
    // The console page is orchestration: no editor tab.
    const editor = this.scope === 'builder' && st.editor;
    if (ws) {
      // setWorkspace on a change (tears panes down); sync on a refresh.
      if (tabs.activeWorkspaceId() !== ws.id) tabs.setWorkspace(ws, editor, initialTab);
      else tabs.sync(ws);
    } else {
      tabs.setWorkspace(null, editor);
    }
  }

  // ---- create dialogs ----

  private openAppDialog(): void {
    this.resetForm('#app-form');
    this.appCwdTouched = false;
    this.updateAppIconPreview('');
    this.dialog('#app-dialog').show();
    this.focusField('#app-name');
  }

  private resetForm(sel: string): void {
    const form = this.querySelector(sel) as HTMLFormElement | null;
    if (!form) return;
    form.querySelectorAll('.field-error').forEach(el => {
      el.textContent = '';
    });
    form.querySelectorAll<WaInput>('wa-input').forEach(el => {
      el.value = null;
    });
  }

  /** After first render: wa-input's .focus() forwards to an inner input built on a microtask. */
  private focusField(sel: string): void {
    requestAnimationFrame(() => (this.querySelector(sel) as WaInput | null)?.focus());
  }

  /** The suggested directory for a new app: the server default cwd plus
   *  the name's slug — the same normalizeSlug the server derives it with. */
  private suggestAppCwd(name: string): string | null {
    const slug = normalizeSlug(name);
    const root = this.state?.defaultCwd;
    if (slug === '' || root === undefined) return null;
    return `${root.replace(/\/+$/, '')}/${slug}`;
  }

  /** The preview shows exactly what the server will pick when the create
   *  carries no icon: the shared rule, default fallback included. */
  private updateAppIconPreview(name: string): void {
    const glyph = this.querySelector('#app-icon-glyph');
    const label = this.querySelector('#app-icon-name');
    if (!glyph || !label) return;
    const icon = name.trim() === '' ? DEFAULT_APP_ICON : suggestAppIcon(name);
    glyph.setAttribute('name', icon);
    label.textContent = `suggested icon: ${icon} (from the name)`;
  }

  private async createApp(): Promise<void> {
    const name = ((this.querySelector('#app-name') as WaInput | null)?.value ?? '').trim();
    // Empty means unset: workspaces start at the server default.
    const cwd = ((this.querySelector('#app-cwd') as WaInput | null)?.value ?? '').trim();
    const done = await this.call('POST', '/api/apps', cwd === '' ? { name } : { name, cwd });
    if (!done) return;
    if (!done.ok) {
      this.errorToast('could not create the app — try again', done.json);
      return;
    }
    this.dialog('#app-dialog').open = false;
    await this.loadState();
    const created = this.state?.apps.find(a => a.id === done.json.id);
    if (created) this.selectApp(created);
    this.toast(`app “${done.json.name}” created`, {
      variant: 'neutral',
      icon: 'circle-check',
      duration: 4000,
    });
  }

  // ---- terminal tabs ----

  /** A failed spawn still carries the row, so it's selected anyway; the first attach retries. */
  private async createTerminal(
    workspaceId: WorkspaceId,
    command: TerminalCommand = 'shell',
  ): Promise<void> {
    const done = await this.call('POST', `/api/workspaces/${workspaceId}/terminals`, { command });
    if (!done) return;
    const row = done.ok ? done.json : done.json?.terminal;
    if (!row?.id) {
      this.errorToast('could not open a terminal — try again', done.json);
      return;
    }
    await this.loadState();
    this.tabs()?.selectTerminal(asTerminalId(row.id));
  }

  /** The tabs already moved optimistically; this persists the order. The
   *  settle report plus the state reload either confirm or revert the bar.
   *  Writes queue onto reorderQueue, so rapid drags stay ordered. */
  private async reorderTerminals(workspaceId: WorkspaceId, order: TerminalId[]): Promise<void> {
    const done = await this.call('PUT', `/api/workspaces/${workspaceId}/terminals/order`, {
      order,
    });
    if (!done) {
      // Network failure: report the revert the next sync will make.
      this.tabs()?.reorderSettled(false);
      await this.loadState();
      return;
    }
    if (!done.ok) {
      this.errorToast('could not reorder the tabs — try again', done.json);
    }
    // The response carries the persisted order, so a superseded write
    // (two rapid drags, slower request landing last) confirms only itself.
    const settled = Array.isArray(done.json?.order)
      ? (done.json.order as string[]).filter(x => UUID_RE.test(x)).map(x => asTerminalId(x))
      : undefined;
    this.tabs()?.reorderSettled(done.ok, settled);
    await this.loadState();
  }

  // ---- delete confirmations ----

  private confirmDelete(pending: PendingDelete): void {
    this.pendingDelete = pending;
    const what =
      pending.kind === 'app'
        ? `the app “${pending.name}” and its workspace`
        : `the terminal “${pending.name}”`;
    (this.querySelector('#confirm-delete-text') as HTMLElement).textContent = `Delete ${what}?`;
    (this.querySelector('#confirm-delete-note') as HTMLElement).textContent =
      pending.kind === 'terminal'
        ? 'The tab closes and its tmux session is killed.'
        : 'Its terminals\u2019 tmux sessions are killed. This cannot be undone.';
    this.dialog('#confirm-delete').show();
  }

  private async runDelete(): Promise<void> {
    const pending = this.pendingDelete;
    if (!pending) return;
    const path =
      pending.kind === 'app' ? `/api/apps/${pending.slug}` : `/api/terminals/${pending.id}`;
    this.pendingDelete = null;
    this.dialog('#confirm-delete').open = false;
    const done = await this.call('DELETE', path);
    if (!done) return;
    if (!done.ok) {
      this.errorToast(`could not delete — try again`, done.json);
      await this.loadState();
      return;
    }
    // A deleted app's selection falls back to the first app on the reload.
    await this.loadState();
  }
}

if (!customElements.get('console-app')) customElements.define('console-app', ConsoleApp);
