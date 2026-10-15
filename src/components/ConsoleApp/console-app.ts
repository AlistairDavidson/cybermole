// console-app.ts — <console-app>: orchestrates the workspace sidebar ↔
// terminal tabs on a <wa-page> app shell (sidebar + free mobile drawer),
// the 15 s state poll, the create/delete dialogs and toasts. Shell markup
// is SSR'd by ConsoleApp.astro; this module registers <console-app>
// client-side and drives it. The dialogs live here, outside the sidebar's
// innerHTML poll; the sidebar and <terminal-tabs> stay stateless emitters
// (select-workspace / new-workspace / new-app / delete-* / new-terminal /
// close-terminal). Page navigation (and sign-out) lives in the global
// <app-header>.
import type { ConsoleState, WorkspaceState } from '../../lib/types';
import type { AppId, AppSlug, TerminalId, TmuxSessionName, WorkspaceId } from '../../types/branded';
import { asTerminalId, asTmuxSessionName, asWorkspaceId } from '../../types/branded';
import { TMUX_SESSION_NAME_RE, UUID_RE } from '../../schemas/patterns';
import { BASE } from '../../base';
import { signedInFetch, type SignedInFetchFailure } from '../signed-in-fetch';
// Registers <validation-enhancer-zod> (and the base <validation-enhancer>).
import 'validation-enhancer/zod';
import type { ValidationEnhancerZod } from 'validation-enhancer/zod';
import { appForm, workspaceForm } from '../../schemas/api';
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

/** Minimal typing for <wa-toast>.create(). */
type WaToast = HTMLElement & {
  create(message: string, options?: Record<string, unknown>): Promise<unknown>;
};

/** Minimal typing for <wa-dialog>. */
type WaDialog = HTMLElement & { show(): void; open: boolean };

/** wa-input surface. An empty wa-input's value is null, not ''. */
type WaInput = HTMLElement & { value: string | null };

/** What the delete-confirmation dialog is about to remove. */
type PendingDelete =
  | { kind: 'workspace'; id: WorkspaceId; name: string }
  | { kind: 'app'; slug: AppSlug; name: string }
  | { kind: 'terminal'; id: TerminalId; name: string };

export class ConsoleApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private state: ConsoleState | null = null;
  private selected: WorkspaceId | null = null;
  /** The group the new-workspace dialog will create under (null = the
   *  console group — the sidebar's or empty state's `+` that opened it). */
  private newWorkspaceAppId: AppId | null = null;
  private pendingDelete: PendingDelete | null = null;
  /** Deep-link target (/?t=<terminal uuid>) — resolved on the first state
   *  load: opens the terminal's workspace with that tab selected. Nothing
   *  to wait for: the terminal attach mode respawns the session on demand
   *  (plan §4), so a dead or never-spawned tab still opens. A uuid that
   *  isn't ours degrades to a toast. */
  private pendingTerminal: TerminalId | null = (() => {
    const v = new URLSearchParams(location.search).get('t') ?? '';
    return UUID_RE.test(v) ? asTerminalId(v) : null;
  })();
  /** Deep-link target (/?run=<session name> — a live job run, the jobs
   *  page's "view" link): shown as the transient run pane on the first
   *  state load. The run mode never respawns — a dead session answers
   *  'no such run session' in the status line. */
  private pendingRun: TmuxSessionName | null = (() => {
    const v = new URLSearchParams(location.search).get('run') ?? '';
    return TMUX_SESSION_NAME_RE.test(v) ? asTmuxSessionName(v) : null;
  })();

  connectedCallback(): void {
    // Event details round-trip through the sidebar's/tab bar's markup,
    // rendered from server state — a trusted source for these ids; the
    // ids are re-checked against the fresh state before use anyway.
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
      const id = (e as CustomEvent<{ workspaceId?: string }>).detail.workspaceId ?? '';
      if (UUID_RE.test(id)) void this.createTerminal(asWorkspaceId(id));
    });
    this.addEventListener('close-terminal', e => {
      const d = (e as CustomEvent<{ id: string }>).detail;
      const t = this.selectedWorkspace()?.terminals.find(x => x.id === d.id);
      this.confirmDelete({ kind: 'terminal', id: asTerminalId(d.id), name: t?.title ?? d.id.slice(0, 8) });
    });
    // Any pane's socket closing (server restart, a drop) → refresh dots.
    this.addEventListener('terminal-closed', () => void this.loadState());
    // A pop-out the browser refused (popup blocker): the pane never
    // moved — say so, it looks like a dead button otherwise.
    this.addEventListener('pop-blocked', () =>
      this.toast('pop-up blocked — allow pop-ups to pop a tab out',
        { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 }));

    // The dialogs' footer buttons live outside their forms (dialog footer
    // slot): submit the form so <validation-enhancer-zod> validates first.
    (this.querySelector('#app-save') as HTMLElement).onclick = () =>
      (this.querySelector('#app-form') as HTMLFormElement).requestSubmit();
    (this.querySelector('#workspace-save') as HTMLElement).onclick = () =>
      (this.querySelector('#workspace-form') as HTMLFormElement).requestSubmit();
    (this.querySelector('#confirm-delete-ok') as HTMLElement).onclick = () => void this.runDelete();
    // Valid submits only: the enhancer stops an invalid one from
    // propagating, so this listener sits ABOVE it — a listener on the
    // form itself would fire (target phase) before validation ran.
    this.addEventListener('submit', e => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      if (form.id === 'app-form') void this.createApp();
      else if (form.id === 'workspace-form') void this.createWorkspace();
    });
    // The forms validate against the same schemas the routes parse with.
    void customElements.whenDefined('validation-enhancer-zod').then(() => {
      (this.querySelector('#app-dialog validation-enhancer-zod') as ValidationEnhancerZod)
        ?.setZodSchema(appForm);
      (this.querySelector('#workspace-dialog validation-enhancer-zod') as ValidationEnhancerZod)
        ?.setZodSchema(workspaceForm);
    });

    void this.loadState();
    this.pollTimer = setInterval(() => { void this.loadState(); }, 15000);
  }

  disconnectedCallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private sidebar(): WorkspaceSidebar | null {
    return this.querySelector('workspace-sidebar') as WorkspaceSidebar | null;
  }

  private tabs(): TerminalTabs | null {
    return this.querySelector('terminal-tabs') as TerminalTabs | null;
  }

  private selectedWorkspace(): WorkspaceState | null {
    return this.state?.workspaces.find(w => w.id === this.selected) ?? null;
  }

  private dialog(sel: string): WaDialog {
    return this.querySelector(sel) as WaDialog;
  }

  private toast(message: string, options?: Record<string, unknown>): void {
    void (this.querySelector('wa-toast') as WaToast | null)?.create(message, options);
  }

  /** A request that got no answer. Signed out needs no toast: the page is
   *  already on its way to /login. */
  private notAnswered(failure: SignedInFetchFailure): void {
    switch (failure.errorCode) {
      case 'signed_out': return;
      case 'network_error':
        this.toast('network error — try again', { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
        return;
      default: return failure satisfies never;
    }
  }

  /** One JSON call; the parsed body (error bodies included) comes back. */
  private async call(method: string, path: string, body?: Record<string, unknown>):
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body, callers narrow it (errorToast: { error?: string })
    Promise<{ ok: boolean; status: number; json: any } | null> {
    const sent = await signedInFetch(`${BASE}${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!sent.ok) { this.notAnswered(sent); return null; }
    const r = sent.data.response;
    const json = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, json };
  }

  private errorToast(fallback: string, json: { error?: string } | null): void {
    this.toast(json?.error ?? fallback, { variant: 'danger', icon: 'triangle-exclamation', duration: 6000 });
  }

  // ---- state poll ----

  async loadState(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/state`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (!r.ok) return;
    const st = await r.json() as ConsoleState;
    this.state = st;
    // Deep links (/?t=…, /?run=…): consumed in ONE pass, on the first
    // state load — a ?t= hit must not leave a ?run= armed to hijack the
    // next poll.
    const pendingTerminal = this.pendingTerminal;
    const pendingRun = this.pendingRun;
    this.pendingTerminal = null;
    this.pendingRun = null;
    if (pendingTerminal) {
      const home = st.workspaces.find(w => w.terminals.some(t => t.id === pendingTerminal));
      if (home) {
        this.selected = home.id;
        this.applySelection(pendingTerminal);
        return;
      }
      // A well-formed uuid that is not ours: shown, and the console still
      // lands on a workspace (the auto-select below) instead of the empty
      // state — the deep link degrades, the page doesn't.
      this.toast('no such terminal', { variant: 'neutral', icon: 'circle-info', duration: 6000 });
    }
    // A deleted-out-from-under selection clears FIRST — the auto-select
    // below then lands on the first remaining workspace immediately, not
    // on an empty state the next poll would un-explain.
    if (this.selected !== null && !this.selectedWorkspace()) this.selected = null;
    // Nothing selected (first load, a missed deep link, or a delete that
    // took the selection): land on the first workspace when one exists
    // (the empty state's create prompt is for empty stores).
    if (this.selected === null && st.workspaces.length > 0) {
      this.selected = st.workspaces[0]!.id;
    }
    // ?run=<session name>: the transient run pane (the jobs page's view).
    if (pendingRun) {
      this.applySelection();
      this.tabs()?.showRun(pendingRun);
      return;
    }
    this.applySelection();
  }

  /** Drive sidebar + tabs from the current state and selection.
   *  initialTab: the ?t= deep link's tab — passed to setWorkspace so it,
   *  not the first tab, is the one that gets a pane. */
  private applySelection(initialTab?: TerminalId): void {
    const st = this.state;
    if (!st) return;
    const ws = this.selectedWorkspace();
    this.sidebar()?.render(st, this.selected);
    const tabs = this.tabs();
    if (!tabs) return;
    if (ws) {
      // setWorkspace on a selection CHANGE (it tears panes down); sync on
      // a refresh of the SAME workspace (panes persist, dots flip).
      if (tabs.activeWorkspaceId() !== ws.id) tabs.setWorkspace(ws, st.editor, initialTab);
      else tabs.sync(ws);
    } else {
      tabs.setWorkspace(null, st.editor);
    }
  }

  // ---- create dialogs ----

  private openAppDialog(): void {
    this.resetForm('#app-form');
    this.dialog('#app-dialog').show();
    this.focusField('#app-name');
  }

  private openWorkspaceDialog(): void {
    this.resetForm('#workspace-form');
    // No folder setting in this dialog (task/app-cwd — the app carries
    // it): show where the workspace will start instead — the parent
    // app's cwd when it has one, else the server default. Mirrors the
    // server's own create-side derivation (Workspaces.saveWorkspace).
    const note = this.querySelector('#workspace-start') as HTMLElement | null;
    const app = this.newWorkspaceAppId === null
      ? null
      : (this.state?.apps ?? []).find(a => a.id === this.newWorkspaceAppId) ?? null;
    const start = app?.cwd ?? this.state?.defaultCwd;
    if (note) note.textContent = start === undefined ? 'starts at the server default' : `starts at ${start}`;
    this.dialog('#workspace-dialog').show();
    this.focusField('#workspace-name');
  }

  /** Clear a dialog form's fields + validation state (a re-open starts
   *  clean — the jobs dialog's discipline). */
  private resetForm(sel: string): void {
    const form = this.querySelector(sel) as HTMLFormElement | null;
    if (!form) return;
    form.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; });
    form.querySelectorAll<WaInput>('wa-input').forEach(el => { el.value = null; });
  }

  /** Focus after <wa-input>'s first render (its .focus() forwards to the
   *  native input inside the shadow root, built on a microtask). */
  private focusField(sel: string): void {
    requestAnimationFrame(() => (this.querySelector(sel) as WaInput | null)?.focus());
  }

  private async createApp(): Promise<void> {
    const name = ((this.querySelector('#app-name') as WaInput | null)?.value ?? '').trim();
    // An empty wa-input's value is null: no cwd field filled = unset —
    // workspaces under the app start at the server default (task/app-cwd).
    const cwd = ((this.querySelector('#app-cwd') as WaInput | null)?.value ?? '').trim();
    const done = await this.call('POST', '/api/apps', cwd === '' ? { name } : { name, cwd });
    if (!done) return;
    if (!done.ok) { this.errorToast('could not create the app — try again', done.json); return; }
    this.dialog('#app-dialog').open = false;
    await this.loadState();
    this.toast(`app “${done.json.name}” created`, { variant: 'neutral', icon: 'circle-check', duration: 4000 });
  }

  private async createWorkspace(): Promise<void> {
    const name = ((this.querySelector('#workspace-name') as WaInput | null)?.value ?? '').trim();
    // No cwd in the body (task/app-cwd): the server derives it — the
    // parent app's cwd, else WEB_PI_NEW_SESSION_CWD.
    const appId = this.newWorkspaceAppId;
    const done = await this.call('POST', '/api/workspaces',
      appId === null ? { name } : { appId, name });
    if (!done) return;
    if (!done.ok) { this.errorToast('could not create the workspace — try again', done.json); return; }
    this.dialog('#workspace-dialog').open = false;
    this.selected = asWorkspaceId(done.json.id);
    await this.loadState();
    this.toast(`workspace “${done.json.name}” created`, { variant: 'neutral', icon: 'circle-check', duration: 4000 });
  }

  // ---- terminal tabs ----

  /** Open a terminal tab (the + button): POST the create, then select the
   *  new tab. A spawn failure still carries the row (plan §4: a dead tab)
   *  — it is selected all the same; the first attach retries the spawn. */
  private async createTerminal(workspaceId: WorkspaceId): Promise<void> {
    const done = await this.call('POST', `/api/workspaces/${workspaceId}/terminals`, {});
    if (!done) return;
    const row = done.ok ? done.json : done.json?.terminal;
    if (!row?.id) { this.errorToast('could not open a terminal — try again', done.json); return; }
    await this.loadState();
    this.tabs()?.selectTerminal(asTerminalId(row.id));
  }

  // ---- delete confirmations ----

  private confirmDelete(pending: PendingDelete): void {
    this.pendingDelete = pending;
    const what = pending.kind === 'workspace'
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
    const path = pending.kind === 'workspace'
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
    // A delete that took the SELECTION with it is loadState's business: its
    // deleted-out check clears the selection and the first-workspace
    // auto-select lands on what remains (the empty state when nothing
    // does).
    await this.loadState();
  }
}

if (!customElements.get('console-app')) customElements.define('console-app', ConsoleApp);
