// <console-app>: drives the workspace sidebar and terminal tabs, the
// /ws/events-driven state refresh (subscribeConsoleEvents), the
// create/delete dialogs, and the desktop nav collapse. The
// dialogs and the nav-collapse control live here, outside the sidebar's
// innerHTML re-render; the sidebar and tabs only emit events.
// Scope "console" (the / page: console workspaces only) or "builder"
// (/builder: the app portfolio — app workspace groups, lifecycle chips from
// the /api/apps/status poll, + app).
import type { ConsoleState, WorkspaceState } from '../../lib/platform/types';
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
import { appForm, buildSessionForm, consoleWorkspaceForm } from '../../schemas/api';
import { workspaceNameFromCwd } from '../../lib/terminals/workspace-name';
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import type { TerminalTabs } from '../TerminalTabs/terminal-tabs';
import '../TerminalTabs/terminal-tabs';
import type { WorkspaceSidebar } from '../workspace-sidebar';
import '../workspace-sidebar';

type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

type WaDialog = HTMLElement & { show(): void; open: boolean };

/** An empty wa-input's value is null, not ''. */
type WaInput = HTMLElement & { value: string | null };

type PendingDelete =
  | { kind: 'workspace'; id: WorkspaceId; name: string }
  | { kind: 'app'; slug: AppSlug; name: string }
  | { kind: 'terminal'; id: TerminalId; name: string };

/** Collapsed desktop nav (the rail), remembered across reloads. Distinct
 *  from the sidebar's group-collapse key (workspace-sidebar.ts). */
const NAV_RAIL_KEY = 'cybermole:sidebar-collapsed';

/** Read once; an unusable storage just means this load starts expanded. */
function readNavRail(): boolean {
  try {
    return localStorage.getItem(NAV_RAIL_KEY) === 'true';
  } catch {
    return false;
  }
}

export class ConsoleApp extends HTMLElement {
  private teardownEvents: (() => void) | null = null;
  private state: ConsoleState | null = null;
  private readonly scope: 'console' | 'builder' =
    this.getAttribute('scope') === 'builder' ? 'builder' : 'console';
  /** The builder scope's portfolio join; null until its first poll lands. */
  private appsStatus: AppsStatusData | null = null;
  private selected: WorkspaceId | null = null;
  /** Where the new-workspace dialog creates (null = the console group). */
  private newWorkspaceAppId: AppId | null = null;
  private pendingDelete: PendingDelete | null = null;
  /** Serializes reorder writes (see the reorder-terminals listener). */
  private reorderQueue: Promise<void> = Promise.resolve();
  /** Desktop nav collapsed to the rail; see NAV_RAIL_KEY. */
  private navCollapsed = readNavRail();
  /** True once the user hand-edits the new-app dialog's cwd: the name no
   *  longer re-suggests a directory. Reset when the dialog reopens. */
  private appCwdTouched = false;
  /** True once the user hand-edits the new-workspace dialog's name: the
   *  name no longer re-suggests from the typed cwd. Reset when the dialog
   *  reopens. */
  private wsNameTouched = false;
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

  connectedCallback(): void {
    // Ids come from server-rendered markup and are re-checked against state anyway.
    this.addEventListener('select-workspace', e => {
      const id = (e as CustomEvent<{ id?: string }>).detail.id ?? '';
      if (!UUID_RE.test(id)) return;
      const target = asWorkspaceId(id);
      if (target !== this.selected) {
        this.selected = target;
        this.applySelection();
      }
    });
    this.addEventListener('new-workspace', e => {
      const appId = (e as CustomEvent<{ appId?: string | null }>).detail.appId ?? null;
      this.newWorkspaceAppId = appId !== null && UUID_RE.test(appId) ? (appId as AppId) : null;
      this.openWorkspaceDialog();
    });
    this.addEventListener('new-app', () => this.openAppDialog());
    this.addEventListener('delete-workspace', e => {
      const d = (e as CustomEvent<{ id: string; name: string }>).detail;
      this.confirmDelete({ kind: 'workspace', id: asWorkspaceId(d.id), name: d.name });
    });
    this.addEventListener('delete-app', e => {
      const d = (e as CustomEvent<{ slug: string; name: string }>).detail;
      this.confirmDelete({ kind: 'app', slug: d.slug as AppSlug, name: d.name });
    });
    this.addEventListener('new-terminal', e => {
      const d = (e as CustomEvent<{ workspaceId?: string; command?: string }>).detail;
      const id = d.workspaceId ?? '';
      const command: TerminalCommand = d.command === 'agent' ? 'agent' : 'shell';
      if (UUID_RE.test(id)) void this.createTerminal(asWorkspaceId(id), command);
    });
    this.addEventListener('reorder-terminals', e => {
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
    this.addEventListener('close-terminal', e => {
      const d = (e as CustomEvent<{ id: string }>).detail;
      const t = this.selectedWorkspace()?.terminals.find(x => x.id === d.id);
      this.confirmDelete({
        kind: 'terminal',
        id: asTerminalId(d.id),
        name: t?.title ?? d.id.slice(0, 8),
      });
    });
    // Any pane's socket closing → refresh the dots.
    this.addEventListener('terminal-closed', () => void this.loadState());
    // Without this, a blocked pop-up looks like a dead button.
    this.addEventListener('pop-blocked', () =>
      this.toast('pop-up blocked — allow pop-ups to pop a tab out', {
        variant: 'danger',
        icon: 'triangle-exclamation',
        duration: 6000,
      }),
    );

    // Footer buttons sit outside their forms; requestSubmit so the enhancer validates first.
    (this.querySelector('#app-save') as HTMLElement).onclick = () =>
      (this.querySelector('#app-form') as HTMLFormElement).requestSubmit();
    (this.querySelector('#workspace-save') as HTMLElement).onclick = () =>
      (this.querySelector('#workspace-form') as HTMLFormElement).requestSubmit();
    (this.querySelector('#confirm-delete-ok') as HTMLElement).onclick = () => void this.runDelete();
    // The nav collapse control: SSR'd static markup in the nav header, so
    // it survives the sidebar's innerHTML re-render (AGENTS.md).
    this.applyNavCollapsed();
    (this.querySelector('#nav-collapse') as HTMLElement | null)?.addEventListener('click', () => {
      this.navCollapsed = !this.navCollapsed;
      try {
        localStorage.setItem(NAV_RAIL_KEY, String(this.navCollapsed));
      } catch {
        /* storage unavailable — this page load only */
      }
      this.applyNavCollapsed();
    });
    // The new-app dialog suggests a directory derived from the name (the
    // server's own slug rule), until the cwd is hand-edited.
    const appName = this.querySelector('#app-name') as WaInput | null;
    const appCwd = this.querySelector('#app-cwd') as WaInput | null;
    if (appName && appCwd) {
      appName.addEventListener('input', () => {
        if (this.appCwdTouched) return;
        appCwd.value = this.suggestAppCwd(appName.value ?? '');
      });
      appCwd.addEventListener('input', () => {
        this.appCwdTouched = true;
      });
    }
    // The new-workspace dialog suggests a name derived from the typed cwd
    // (the server's own derivation rule, siblings included), until the
    // name is hand-edited. Console scope only — the builder dialog has no
    // cwd field (build sessions are pinned to the root cwd).
    const wsCwd = this.querySelector('#workspace-cwd') as WaInput | null;
    const wsName = this.querySelector('#workspace-name') as WaInput | null;
    if (wsCwd && wsName) {
      wsCwd.addEventListener('input', () => {
        const typed = wsCwd.value ?? '';
        this.updateWorkspaceStartNote(typed);
        if (this.wsNameTouched) return;
        wsName.value = this.suggestWorkspaceName(typed);
      });
      wsName.addEventListener('input', () => {
        this.wsNameTouched = true;
      });
    }
    // Above the enhancer: it stops invalid submits from propagating, and a
    // listener on the form itself would fire before validation.
    this.addEventListener('submit', e => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      if (form.id === 'app-form') void this.createApp();
      else if (form.id === 'workspace-form') void this.createWorkspace();
    });
    void customElements.whenDefined('validation-enhancer-zod').then(() => {
      (
        this.querySelector('#app-dialog validation-enhancer-zod') as ValidationEnhancerZod
      )?.setZodSchema(appForm);
      (
        this.querySelector('#workspace-dialog validation-enhancer-zod') as ValidationEnhancerZod
      )?.setZodSchema(this.scope === 'builder' ? buildSessionForm : consoleWorkspaceForm);
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

  private sidebar(): WorkspaceSidebar | null {
    return this.querySelector('workspace-sidebar') as WorkspaceSidebar | null;
  }

  private tabs(): TerminalTabs | null {
    return this.querySelector('terminal-tabs') as TerminalTabs | null;
  }

  private selectedWorkspace(): WorkspaceState | null {
    return this.scopedWorkspaces().find(w => w.id === this.selected) ?? null;
  }

  /** This page's half of the world: console shows app_id NULL, builder the
   *  app workspaces. */
  private scopedWorkspaces(): WorkspaceState[] {
    const st = this.state;
    if (!st) return [];
    return st.workspaces.filter(w =>
      this.scope === 'console' ? w.appId === null : w.appId !== null,
    );
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
        // Deep links route by owner: an app workspace's tab belongs on the
        // builder page, a console workspace's on the console.
        if (this.scope === 'console' && home.appId !== null) {
          location.replace(`${BASE}/builder?t=${pendingTerminal}`);
          return;
        }
        if (this.scope === 'builder' && home.appId === null) {
          location.replace(`${BASE}/?t=${pendingTerminal}`);
          return;
        }
        this.selected = home.id;
        this.applySelection(pendingTerminal);
        return;
      }
      // Not ours: toast, and still land on a workspace below.
      this.toast('no such terminal', { variant: 'neutral', icon: 'circle-info', duration: 6000 });
    }
    // Clear a deleted (or other-scoped) selection first, then fall back to
    // the first workspace this page shows.
    const scoped = this.scopedWorkspaces();
    if (this.selected !== null && !scoped.some(w => w.id === this.selected)) this.selected = null;
    if (this.selected === null && scoped.length > 0) {
      this.selected = scoped[0]!.id;
    }
    if (pendingRun) {
      this.applySelection();
      this.tabs()?.showRun(pendingRun);
      return;
    }
    this.applySelection();
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
    this.sidebar()?.render(st, this.selected, {
      scope: this.scope,
      appsStatus: this.appsStatus,
    });
    const tabs = this.tabs();
    if (!tabs) return;
    if (ws) {
      // setWorkspace on a change (tears panes down); sync on a refresh.
      if (tabs.activeWorkspaceId() !== ws.id) tabs.setWorkspace(ws, st.editor, initialTab);
      else tabs.sync(ws);
    } else {
      tabs.setWorkspace(null, st.editor);
    }
  }

  // ---- create dialogs ----

  private openAppDialog(): void {
    this.resetForm('#app-form');
    this.appCwdTouched = false;
    this.dialog('#app-dialog').show();
    this.focusField('#app-name');
  }

  private openWorkspaceDialog(): void {
    this.resetForm('#workspace-form');
    this.wsNameTouched = false;
    this.updateWorkspaceStartNote('');
    this.dialog('#workspace-dialog').show();
    // Console flows from the directory (the name suggests itself from it);
    // a build session starts at the name.
    this.focusField(this.scope === 'builder' ? '#workspace-name' : '#workspace-cwd');
  }

  /** The start note: where the dialog's cwd field points once it holds
   *  something, else the server's derivation (the parent app's cwd, else
   *  the default — the root default framed at the app for a build session). */
  private updateWorkspaceStartNote(cwd: string): void {
    const note = this.querySelector('#workspace-start') as HTMLElement | null;
    if (!note) return;
    const typed = cwd.trim();
    if (typed !== '') {
      note.textContent = `starts at ${typed}`;
      return;
    }
    const app =
      this.newWorkspaceAppId === null
        ? null
        : ((this.state?.apps ?? []).find(a => a.id === this.newWorkspaceAppId) ?? null);
    if (this.scope === 'builder') {
      // Build sessions work from the root cwd, framed at the app — never
      // at the app tree (the server skips the parent's cwd for 'build').
      note.textContent = `starts at ${this.state?.defaultCwd ?? 'the server default'} — the build session for ${app?.name ?? 'this app'}`;
    } else {
      const start = app?.cwd ?? this.state?.defaultCwd;
      note.textContent =
        start === undefined ? 'starts at the server default' : `starts at ${start}`;
    }
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

  /** The suggested name for a new console workspace: the server's own
   *  derivation — the typed cwd's basename, uniquified against the names
   *  the group already holds (workspace-name.ts is the shared rule). */
  private suggestWorkspaceName(cwd: string): string | null {
    const typed = cwd.trim();
    if (typed === '') return null;
    const siblings = (this.state?.workspaces ?? [])
      .filter(w => w.appId === this.newWorkspaceAppId)
      .map(w => w.name);
    return workspaceNameFromCwd(typed, siblings);
  }

  /** Reflects the collapse on the host (console.css owns the look) and on
   *  the control's semantics. */
  private applyNavCollapsed(): void {
    this.toggleAttribute('data-nav-collapsed', this.navCollapsed);
    const toggle = this.querySelector('#nav-collapse') as HTMLElement | null;
    if (toggle) {
      const label = this.navCollapsed ? 'expand the sidebar' : 'collapse the sidebar';
      toggle.setAttribute('aria-expanded', this.navCollapsed ? 'false' : 'true');
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('title', label);
    }
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
    this.toast(`app “${done.json.name}” created`, {
      variant: 'neutral',
      icon: 'circle-check',
      duration: 4000,
    });
  }

  private async createWorkspace(): Promise<void> {
    const name = ((this.querySelector('#workspace-name') as WaInput | null)?.value ?? '').trim();
    // No cwd: the server derives it. Builder workspaces are build sessions
    // (kind 'build': root cwd + the framing env); console ones stay plain.
    // Empty strings mean "derive it server-side": absent name → the cwd's
    // basename, absent cwd → the parent app's, else the server default.
    const cwd = ((this.querySelector('#workspace-cwd') as WaInput | null)?.value ?? '').trim();
    const appId = this.newWorkspaceAppId;
    const derived = { ...(name === '' ? {} : { name }), ...(cwd === '' ? {} : { cwd }) };
    const body =
      appId === null
        ? derived
        : this.scope === 'builder'
          ? { appId, ...derived, kind: 'build' as const }
          : { appId, ...derived };
    const done = await this.call('POST', '/api/workspaces', body);
    if (!done) return;
    if (!done.ok) {
      this.errorToast('could not create the workspace — try again', done.json);
      return;
    }
    this.dialog('#workspace-dialog').open = false;
    this.selected = asWorkspaceId(done.json.id);
    await this.loadState();
    this.toast(`workspace “${done.json.name}” created`, {
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
      pending.kind === 'workspace'
        ? `the workspace “${pending.name}”`
        : pending.kind === 'app'
          ? `the app “${pending.name}” and every workspace in it`
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
      pending.kind === 'workspace'
        ? `/api/workspaces/${pending.id}`
        : pending.kind === 'app'
          ? `/api/apps/${pending.slug}`
          : `/api/terminals/${pending.id}`;
    this.pendingDelete = null;
    this.dialog('#confirm-delete').open = false;
    const done = await this.call('DELETE', path);
    if (!done) return;
    if (!done.ok) {
      this.errorToast(`could not delete — try again`, done.json);
      await this.loadState();
      return;
    }
    // If the selection was deleted, loadState clears it and picks what's left.
    await this.loadState();
  }
}

if (!customElements.get('console-app')) customElements.define('console-app', ConsoleApp);
