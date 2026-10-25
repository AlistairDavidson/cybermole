// <console-app>: drives the workspace sidebar and terminal tabs, the 15 s
// state poll, and the create/delete dialogs. The dialogs live here, outside
// the sidebar's innerHTML re-render; the sidebar and tabs only emit events.
import type { ConsoleState, WorkspaceState } from '../../lib/platform/types';
import {
  asTerminalId,
  asTmuxSessionName,
  asWorkspaceId,
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

export class ConsoleApp extends HTMLElement {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private state: ConsoleState | null = null;
  private selected: WorkspaceId | null = null;
  /** Where the new-workspace dialog creates (null = the console group). */
  private newWorkspaceAppId: AppId | null = null;
  private pendingDelete: PendingDelete | null = null;
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
      const id = (e as CustomEvent<{ workspaceId?: string }>).detail.workspaceId ?? '';
      if (UUID_RE.test(id)) void this.createTerminal(asWorkspaceId(id));
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
      )?.setZodSchema(workspaceForm);
    });

    void this.loadState();
    this.pollTimer = setInterval(() => {
      void this.loadState();
    }, 15000);
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

  // ---- state poll ----

  async loadState(): Promise<void> {
    const sent = await signedInFetch(`${BASE}/api/state`);
    if (!sent.ok) return;
    const r = sent.data.response;
    if (!r.ok) return;
    const st = (await r.json()) as ConsoleState;
    this.state = st;
    // Deep links are consumed in one pass, so a ?t= hit can't leave a ?run=
    // armed for the next poll.
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
      // Not ours: toast, and still land on a workspace below.
      this.toast('no such terminal', { variant: 'neutral', icon: 'circle-info', duration: 6000 });
    }
    // Clear a deleted selection first, then fall back to the first workspace.
    if (this.selected !== null && !this.selectedWorkspace()) this.selected = null;
    if (this.selected === null && st.workspaces.length > 0) {
      this.selected = st.workspaces[0]!.id;
    }
    if (pendingRun) {
      this.applySelection();
      this.tabs()?.showRun(pendingRun);
      return;
    }
    this.applySelection();
  }

  /** initialTab (the ?t= deep link) gets the pane instead of the first tab. */
  private applySelection(initialTab?: TerminalId): void {
    const st = this.state;
    if (!st) return;
    const ws = this.selectedWorkspace();
    this.sidebar()?.render(st, this.selected);
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
    this.dialog('#app-dialog').show();
    this.focusField('#app-name');
  }

  private openWorkspaceDialog(): void {
    this.resetForm('#workspace-form');
    // Show where the workspace will start, mirroring the server's derivation.
    const note = this.querySelector('#workspace-start') as HTMLElement | null;
    const app =
      this.newWorkspaceAppId === null
        ? null
        : ((this.state?.apps ?? []).find(a => a.id === this.newWorkspaceAppId) ?? null);
    const start = app?.cwd ?? this.state?.defaultCwd;
    if (note)
      note.textContent =
        start === undefined ? 'starts at the server default' : `starts at ${start}`;
    this.dialog('#workspace-dialog').show();
    this.focusField('#workspace-name');
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
    // No cwd: the server derives it.
    const appId = this.newWorkspaceAppId;
    const done = await this.call(
      'POST',
      '/api/workspaces',
      appId === null ? { name } : { appId, name },
    );
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
  private async createTerminal(workspaceId: WorkspaceId): Promise<void> {
    const done = await this.call('POST', `/api/workspaces/${workspaceId}/terminals`, {});
    if (!done) return;
    const row = done.ok ? done.json : done.json?.terminal;
    if (!row?.id) {
      this.errorToast('could not open a terminal — try again', done.json);
      return;
    }
    await this.loadState();
    this.tabs()?.selectTerminal(asTerminalId(row.id));
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
