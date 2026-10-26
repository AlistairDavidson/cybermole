// Workspaces (a cwd + terminal tabs) belong to the console (app_id NULL) or
// one app. Each terminal tab is a tmux session 't-<uuid>', derived from the
// row id. The row exists even when the spawn fails; the first attach retries.
// Deletes cascade through FKs; tmux kills are best-effort.
// A kind='build' workspace is a build session: cwd stays the console default
// (the parent app's cwd is skipped) and every spawn carries the framing env
// (CYBERMOLE_WORKSPACE_FOCUS[_TREE]) — advisory attention, never authority.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { qb, type StateDb } from '../platform/db';
import { databaseRead, databaseUpdate, type DatabaseReadResult } from '@cybermole/app-kit';
import { componentLogger } from '../platform/logger';
import { terminalSessionName } from './tmux';
import { splitCommandLine } from './terminal-defaults';
import { reorderUpdates, type TerminalCommand } from './tab-order';
import { orderPlan } from '../order-plan';
import {
  asTerminalId,
  asWorkspaceId,
  type AppId,
  type ResultFailure,
  type ResultSuccess,
  type TerminalId,
  type TmuxSessionName,
  type WorkspaceId,
} from '@cybermole/app-kit';
import type { WorkspaceState } from '../platform/types';
import type { TmuxSessionFailure, TmuxSessionSuccess } from './tmux';

const log = componentLogger('workspaces');

// ---------- results ----------

/** 'build' is the only kind; NULL covers console and legacy in-tree rows. */
export type WorkspaceKind = 'build' | null;
export type SaveWorkspaceData = {
  id: WorkspaceId;
  appId: AppId | null;
  name: string;
  cwd: string;
  kind: WorkspaceKind;
};
/** invalid_cwd: not absolute or not an existing directory. invalid_kind:
 *  kind 'build' without an appId (the API schema rejects it first; this is
 *  the closed-code backstop). app_not_found is pre-checked; the
 *  check-then-insert race degrades to database_error. */
export type SaveWorkspaceErrorCode =
  | 'invalid_name'
  | 'invalid_cwd'
  | 'invalid_kind'
  | 'app_not_found'
  | 'workspace_not_found'
  | 'database_error';
export type SaveWorkspaceSuccess = ResultSuccess<'save_workspace', SaveWorkspaceData>;
export type SaveWorkspaceFailure = ResultFailure<
  'save_workspace',
  SaveWorkspaceData,
  SaveWorkspaceErrorCode
>;
export type SaveWorkspaceResult = SaveWorkspaceSuccess | SaveWorkspaceFailure;

export type DeleteWorkspaceData = { id: WorkspaceId };
export type DeleteWorkspaceErrorCode = 'workspace_not_found' | 'database_error';
export type DeleteWorkspaceSuccess = ResultSuccess<'delete_workspace', DeleteWorkspaceData>;
export type DeleteWorkspaceFailure = ResultFailure<
  'delete_workspace',
  DeleteWorkspaceData,
  DeleteWorkspaceErrorCode
>;
export type DeleteWorkspaceResult = DeleteWorkspaceSuccess | DeleteWorkspaceFailure;

export type NewTerminalData = {
  id: TerminalId;
  workspaceId: WorkspaceId;
  title: string | null;
  live: boolean;
};
/** server_not_running / tmux_error: the row was still created and is
 *  carried on the failure's data (live:false); the first attach retries. */
export type NewTerminalErrorCode =
  'workspace_not_found' | 'server_not_running' | 'tmux_error' | 'database_error';
export type NewTerminalSuccess = ResultSuccess<'new_terminal', NewTerminalData>;
export type NewTerminalFailure = ResultFailure<
  'new_terminal',
  NewTerminalData,
  NewTerminalErrorCode
>;
export type NewTerminalResult = NewTerminalSuccess | NewTerminalFailure;

export type CloseTerminalData = { id: TerminalId };
export type CloseTerminalErrorCode = 'terminal_not_found' | 'database_error';
export type CloseTerminalSuccess = ResultSuccess<'close_terminal', CloseTerminalData>;
export type CloseTerminalFailure = ResultFailure<
  'close_terminal',
  CloseTerminalData,
  CloseTerminalErrorCode
>;
export type CloseTerminalResult = CloseTerminalSuccess | CloseTerminalFailure;

export type RenameTerminalData = { id: TerminalId; title: string | null };
export type RenameTerminalErrorCode = 'terminal_not_found' | 'database_error';
export type RenameTerminalSuccess = ResultSuccess<'rename_terminal', RenameTerminalData>;
export type RenameTerminalFailure = ResultFailure<
  'rename_terminal',
  RenameTerminalData,
  RenameTerminalErrorCode
>;
export type RenameTerminalResult = RenameTerminalSuccess | RenameTerminalFailure;

/** A full-list reorder: the ids are the workspace's terminals, each once,
 *  in their new order. invalid_order means the list doesn't match the
 *  workspace (a stale client re-reads state and retries). */
export type ReorderTerminalsData = { workspaceId: WorkspaceId; order: TerminalId[] };
export type ReorderTerminalsErrorCode = 'workspace_not_found' | 'invalid_order' | 'database_error';
export type ReorderTerminalsSuccess = ResultSuccess<'reorder_terminals', ReorderTerminalsData>;
export type ReorderTerminalsFailure = ResultFailure<
  'reorder_terminals',
  ReorderTerminalsData,
  ReorderTerminalsErrorCode
>;

/** A full-list reorder within one group (the console's or one app's): the
 *  ids are that group's workspaces, each once, in their new order. The
 *  group is whichever parent the listed rows share; ids from two groups
 *  (or nowhere) are invalid_order — a stale client re-reads state and
 *  retries. */
export type ReorderWorkspacesData = { order: WorkspaceId[] };
export type ReorderWorkspacesErrorCode = 'invalid_order' | 'database_error';
export type ReorderWorkspacesSuccess = ResultSuccess<'reorder_workspaces', ReorderWorkspacesData>;
export type ReorderWorkspacesFailure = ResultFailure<
  'reorder_workspaces',
  ReorderWorkspacesData,
  ReorderWorkspacesErrorCode
>;
export type ReorderWorkspacesResult = ReorderWorkspacesSuccess | ReorderWorkspacesFailure;
export type ReorderTerminalsResult = ReorderTerminalsSuccess | ReorderTerminalsFailure;

/** `agent`: this is the workspace's auto-opened agent tab, so a respawn
 *  runs the agent command rather than the shell. `env`: the build-session
 *  framing vars for a respawned spawn (merged over the session env), or
 *  null on a plain workspace. */
export type TerminalForAttachData = {
  id: TerminalId;
  workspaceId: WorkspaceId;
  title: string | null;
  cwd: string;
  agent: boolean;
  env: Record<string, string> | null;
};
export type TerminalForAttachErrorCode = 'terminal_not_found' | 'database_error';
export type TerminalForAttachSuccess = ResultSuccess<'terminal_for_attach', TerminalForAttachData>;
export type TerminalForAttachFailure = ResultFailure<
  'terminal_for_attach',
  TerminalForAttachData,
  TerminalForAttachErrorCode
>;
export type TerminalForAttachResult = TerminalForAttachSuccess | TerminalForAttachFailure;

/** live: the tab's `t-<uuid>` tmux session exists. */
export type WorkspaceTreeData = { workspaces: WorkspaceState[] };
export type WorkspaceTreeErrorCode = 'database_error';
export type WorkspaceTreeSuccess = ResultSuccess<'workspace_tree', WorkspaceTreeData>;
export type WorkspaceTreeFailure = ResultFailure<
  'workspace_tree',
  WorkspaceTreeData,
  WorkspaceTreeErrorCode
>;
export type WorkspaceTreeResult = WorkspaceTreeSuccess | WorkspaceTreeFailure;

// ---------- helpers ----------

/** Absolute and an existing directory. Catches typos, not access: the
 *  caller already has a shell at this privilege. */
export function checkedCwd(cwd: string): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (!cwd.startsWith('/')) return { ok: false, reason: `cwd must be an absolute path: ${cwd}` };
  try {
    if (!fs.statSync(cwd).isDirectory())
      return { ok: false, reason: `cwd is not a directory: ${cwd}` };
  } catch {
    return { ok: false, reason: `cwd does not exist: ${cwd}` };
  }
  return { ok: true, cwd };
}

// ---------- domain ----------

export interface WorkspacesDeps {
  db: StateDb;
  /** The credential's username, for created_by/updated_by. */
  username: () => DatabaseReadResult<string | null>;
  killSession: (name: TmuxSessionName) => Promise<boolean>;
  /** Injected so the domain is testable without tmux. Per-session env for
   *  this spawn (the build-session framing), merged over the session env. */
  spawnSession: (
    name: TmuxSessionName,
    cwd: string,
    command: string[],
    env?: Record<string, string>,
  ) => Promise<TmuxSessionSuccess | TmuxSessionFailure>;
  /** The shell command for new tabs; read per spawn so /settings applies immediately. */
  shellCommand: () => DatabaseReadResult<string>;
  /** The agent command for a new workspace's first tab. */
  agentCommand: () => DatabaseReadResult<string>;
  /** Used when neither the create nor the parent app gives a cwd. */
  defaultCwd: string;
  /** CYBERMOLE_APPS_ROOT: the focus tree for a build app with no cwd. */
  appsRoot: string;
  /** Can't fail: a down tmux server reads as nothing live. */
  liveSessionNames: () => Promise<Set<TmuxSessionName>>;
}

export class Workspaces {
  constructor(private deps: WorkspacesDeps) {}

  private actor(): { ok: true; username: string } | { ok: false; errorMessage: string } {
    const who = this.deps.username();
    return who.ok
      ? { ok: true, username: who.data.value ?? 'unknown' }
      : { ok: false, errorMessage: who.errorMessage ?? 'could not read the credential' };
  }

  private byId(id: WorkspaceId) {
    return databaseRead(
      'could not read workspace',
      () =>
        this.deps.db.get(
          qb
            .selectFrom('workspaces')
            .select(['id', 'app_id', 'name', 'cwd', 'kind', 'created_at'])
            .where('id', '=', id),
        ) ?? null,
    );
  }

  /** The app row a build session is framed at, for the focus env. */
  private appForFocus(appId: AppId) {
    return databaseRead('could not read app', () =>
      this.deps.db.get(qb.selectFrom('apps').select(['id', 'slug', 'cwd']).where('id', '=', appId)),
    );
  }

  /** The framing one-liner as env. The tree states intent (the app row's
   *  cwd, else <appsRoot>/<slug>); the root AGENTS.md tells the agent to
   *  check it exists. */
  private focusEnv(kind: WorkspaceKind, slug: string, appCwd: string | null) {
    if (kind !== 'build') return null;
    return {
      CYBERMOLE_WORKSPACE_FOCUS: slug,
      CYBERMOLE_WORKSPACE_FOCUS_TREE: appCwd ?? path.join(this.deps.appsRoot, slug),
    } satisfies Record<string, string>;
  }

  /** Reads the app row and derives the framing env for a stored workspace. */
  private focusEnvByRow(row: {
    kind: string | null;
    app_id: AppId | null;
  }): { ok: true; env: Record<string, string> | null } | { ok: false; errorMessage: string } {
    if (row.kind !== 'build' || row.app_id === null) return { ok: true, env: null };
    const app = this.appForFocus(row.app_id);
    if (!app.ok)
      return {
        ok: false,
        errorMessage: app.errorMessage ?? 'could not read app',
      };
    if (!app.data.value) return { ok: true, env: null };
    const { slug, cwd } = app.data.value;
    return { ok: true, env: this.focusEnv('build', slug, cwd) };
  }

  private terminal(id: TerminalId) {
    return databaseRead(
      'could not read terminal',
      () =>
        this.deps.db.get(
          qb.selectFrom('terminals').select(['id', 'workspace_id', 'title']).where('id', '=', id),
        ) ?? null,
    );
  }

  /** Steps of 10 per parent. */
  private nextOrder(appId: AppId | null) {
    return databaseRead(
      'could not read workspace order',
      () =>
        (this.deps.db.get(
          qb
            .selectFrom('workspaces')
            .select(eb => eb.fn.max<number | null>('sort_order').as('max'))
            .where('app_id', 'is', appId),
        )?.max ?? 0) + 10,
    );
  }

  /** cwd: explicit, else the parent app's, else the default — except kind
   *  'build', which always takes the default (a build session works from
   *  the root cwd, never the app tree). Validated either way, since the
   *  app's dir may have gone since it was saved. */
  async saveWorkspace(input: {
    appId?: AppId | null;
    name: string;
    cwd?: string;
    kind?: 'build';
  }): Promise<SaveWorkspaceResult> {
    const fail = (errorCode: SaveWorkspaceErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'save_workspace',
        errorCode,
        errorMessage,
      }) satisfies SaveWorkspaceFailure;
    const name = input.name.trim();
    if (!name) return fail('invalid_name', 'name is required');
    const appId = input.appId ?? null;
    const kind: WorkspaceKind = input.kind === 'build' ? 'build' : null;
    if (kind === 'build' && appId === null)
      return fail('invalid_kind', "kind 'build' requires an appId");
    let parentCwd: string | null = null;
    let focusEnv: Record<string, string> | null = null;
    if (appId !== null) {
      // Pre-check the FK so it's a closed code; also reads the app's cwd.
      const parent = databaseRead(
        'could not read app',
        () =>
          this.deps.db.get(
            qb.selectFrom('apps').select(['id', 'slug', 'cwd']).where('id', '=', appId),
          ) ?? null,
      );
      if (!parent.ok) return fail('database_error', parent.errorMessage);
      if (!parent.data.value) return fail('app_not_found', 'no such app');
      parentCwd = parent.data.value.cwd;
      focusEnv = this.focusEnv(kind, parent.data.value.slug, parentCwd);
    }
    const wanted =
      input.cwd !== undefined
        ? input.cwd
        : kind === 'build'
          ? this.deps.defaultCwd
          : (parentCwd ?? this.deps.defaultCwd);
    const cwd = checkedCwd(wanted);
    if (!cwd.ok) return fail('invalid_cwd', cwd.reason);
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const order = this.nextOrder(appId);
    if (!order.ok) return fail('database_error', order.errorMessage);
    const id = asWorkspaceId(randomUUID());
    const now = Date.now();
    const inserted = databaseUpdate('could not save the workspace', () =>
      this.deps.db.run(
        qb.insertInto('workspaces').values({
          id,
          app_id: appId,
          name,
          cwd: cwd.cwd,
          kind,
          sort_order: order.data.value,
          created_at: now,
          updated_at: now,
          created_by: actor.username,
          updated_by: actor.username,
        }),
      ),
    );
    if (!inserted.ok) return fail('database_error', inserted.errorMessage);
    log.info(
      `workspace "${name}" created (cwd ${cwd.cwd}, ` +
        `${appId === null ? 'console' : `app ${appId}`}${kind === 'build' ? ', build' : ''})`,
    );
    // A new workspace auto-opens its agent tab. A failed spawn never fails
    // the create. The tab carries command 'agent' (and the workspace's
    // exact created_at, which is what marks the agent slot on pre-v7 rows).
    const opened = await this.openTab(id, cwd.cwd, undefined, 'agent', now, focusEnv);
    if (!opened.ok)
      log.warn(
        `workspace "${name}": its first terminal did not start ` +
          `(${opened.errorCode}: ${opened.errorMessage}) — the tab is there, the first attach retries`,
      );
    return {
      ok: true,
      resultType: 'save_workspace',
      data: { id, appId, name, cwd: cwd.cwd, kind },
    } satisfies SaveWorkspaceSuccess;
  }

  /** Absent fields keep their value. */
  async updateWorkspace(
    id: WorkspaceId,
    input: { name?: string; cwd?: string },
  ): Promise<SaveWorkspaceResult> {
    const fail = (errorCode: SaveWorkspaceErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'save_workspace',
        errorCode,
        errorMessage,
      }) satisfies SaveWorkspaceFailure;
    const found = this.byId(id);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('workspace_not_found', 'no such workspace');
    const name = input.name === undefined ? undefined : input.name.trim();
    if (name === '') return fail('invalid_name', 'name is required');
    const cwd = input.cwd === undefined ? undefined : checkedCwd(input.cwd);
    if (cwd !== undefined && !cwd.ok) return fail('invalid_cwd', cwd.reason);
    if (name === undefined && cwd === undefined) {
      return {
        ok: true,
        resultType: 'save_workspace',
        data: {
          id: row.id,
          appId: row.app_id,
          name: row.name,
          cwd: row.cwd,
          kind: row.kind === 'build' ? 'build' : null,
        },
      } satisfies SaveWorkspaceSuccess;
    }
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    // The patch API never carries kind: it is set at birth and reads back
    // from the row, never patched.
    const updated = databaseUpdate('could not save the workspace', () =>
      this.deps.db.run(
        qb
          .updateTable('workspaces')
          .set({
            ...(name === undefined ? {} : { name }),
            ...(cwd === undefined ? {} : { cwd: cwd.cwd }),
            updated_at: Date.now(),
            updated_by: actor.username,
          })
          .where('id', '=', id),
      ),
    );
    if (!updated.ok) return fail('database_error', updated.errorMessage);
    return {
      ok: true,
      resultType: 'save_workspace',
      data: {
        id,
        appId: row.app_id,
        name: name ?? row.name,
        cwd: cwd === undefined ? row.cwd : cwd.cwd,
        kind: row.kind === 'build' ? 'build' : null,
      },
    } satisfies SaveWorkspaceSuccess;
  }

  /** Tmux kills happen after the cascade and never fail the delete. */
  async deleteWorkspace(id: WorkspaceId): Promise<DeleteWorkspaceResult> {
    const fail = (errorCode: DeleteWorkspaceErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'delete_workspace',
        errorCode,
        errorMessage,
      }) satisfies DeleteWorkspaceFailure;
    const found = this.byId(id);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('workspace_not_found', 'no such workspace');
    const terminals = databaseRead('could not read terminals', () =>
      this.deps.db.all(qb.selectFrom('terminals').select('id').where('workspace_id', '=', id)),
    );
    if (!terminals.ok) return fail('database_error', terminals.errorMessage);
    const deleted = databaseUpdate('could not delete the workspace', () =>
      this.deps.db.run(qb.deleteFrom('workspaces').where('id', '=', id)),
    );
    if (!deleted.ok) return fail('database_error', deleted.errorMessage);
    for (const t of terminals.data.value) await this.deps.killSession(terminalSessionName(t.id));
    log.info(
      `workspace "${row.name}" deleted (${terminals.data.value.length} terminal sessions killed best-effort)`,
    );
    return {
      ok: true,
      resultType: 'delete_workspace',
      data: { id },
    } satisfies DeleteWorkspaceSuccess;
  }

  /** Inserts the row, then spawns best-effort; a failed spawn still
   *  returns the row (live:false) for the first attach to retry.
   *  command picks what the tab runs now and on every respawn. */
  async newTerminal(
    workspaceId: WorkspaceId,
    title: string | undefined,
    command: TerminalCommand = 'shell',
  ): Promise<NewTerminalResult> {
    const fail = (errorCode: NewTerminalErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'new_terminal',
        errorCode,
        errorMessage,
      }) satisfies NewTerminalFailure;
    const found = this.byId(workspaceId);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('workspace_not_found', 'no such workspace');
    // created_at equal to the workspace's marks the agent slot (the legacy
    // derivation for pre-v7 rows), so a later tab must stay strictly later
    // (a script can land in the same ms).
    const createdAt = Math.max(Date.now(), row.created_at + 1);
    // A build workspace's later tabs carry the framing too.
    const focus = this.focusEnvByRow(row);
    if (!focus.ok) return fail('database_error', focus.errorMessage);
    return this.openTab(workspaceId, row.cwd, title, command, createdAt, focus.env);
  }

  /** Row first, then the spawn. A failed command read returns before the
   *  insert, so no row. */
  private async openTab(
    workspaceId: WorkspaceId,
    cwd: string,
    title: string | null | undefined,
    command: TerminalCommand,
    createdAt: number,
    env: Record<string, string> | null = null,
  ): Promise<NewTerminalResult> {
    const fail = (errorCode: NewTerminalErrorCode, errorMessage: string, data?: NewTerminalData) =>
      ({
        ok: false,
        resultType: 'new_terminal',
        errorCode,
        errorMessage,
        ...(data ? { data } : {}),
      }) satisfies NewTerminalFailure;
    const resolved = command === 'agent' ? this.deps.agentCommand() : this.deps.shellCommand();
    if (!resolved.ok)
      return fail('database_error', resolved.errorMessage ?? 'could not read the terminal command');
    const argv = splitCommandLine(resolved.data.value);
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const order = databaseRead(
      'could not read terminal order',
      () =>
        (this.deps.db.get(
          qb
            .selectFrom('terminals')
            .select(eb => eb.fn.max<number | null>('sort_order').as('max'))
            .where('workspace_id', '=', workspaceId),
        )?.max ?? 0) + 10,
    );
    if (!order.ok) return fail('database_error', order.errorMessage);
    const id = asTerminalId(randomUUID());
    const now = createdAt;
    const inserted = databaseUpdate('could not save the terminal', () =>
      this.deps.db.run(
        qb.insertInto('terminals').values({
          id,
          workspace_id: workspaceId,
          title: title ?? null,
          sort_order: order.data.value,
          command,
          created_at: now,
          updated_at: now,
          created_by: actor.username,
          updated_by: actor.username,
        }),
      ),
    );
    if (!inserted.ok) return fail('database_error', inserted.errorMessage);
    const data: NewTerminalData = { id, workspaceId, title: title ?? null, live: false };
    const spawned = await this.deps.spawnSession(
      terminalSessionName(id),
      cwd,
      argv,
      env === null ? undefined : env,
    );
    if (!spawned.ok) {
      log.warn(
        `terminal ${id} created but its tmux session did not start (${spawned.errorCode}: ${spawned.errorMessage})`,
      );
      return fail(
        spawned.errorCode,
        spawned.errorMessage ?? 'could not start the terminal session',
        data,
      );
    }
    log.info(`terminal ${id} opened (${terminalSessionName(id)} at ${cwd})`);
    return {
      ok: true,
      resultType: 'new_terminal',
      data: { ...data, live: true },
    } satisfies NewTerminalSuccess;
  }

  async closeTerminal(id: TerminalId): Promise<CloseTerminalResult> {
    const fail = (errorCode: CloseTerminalErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'close_terminal',
        errorCode,
        errorMessage,
      }) satisfies CloseTerminalFailure;
    const found = this.terminal(id);
    if (!found.ok) return fail('database_error', found.errorMessage);
    if (!found.data.value) return fail('terminal_not_found', 'no such terminal');
    const deleted = databaseUpdate('could not delete the terminal', () =>
      this.deps.db.run(qb.deleteFrom('terminals').where('id', '=', id)),
    );
    if (!deleted.ok) return fail('database_error', deleted.errorMessage);
    await this.deps.killSession(terminalSessionName(id));
    return { ok: true, resultType: 'close_terminal', data: { id } } satisfies CloseTerminalSuccess;
  }

  /** title null clears it back to the "term N" label; undefined is a no-op. */
  async renameTerminal(
    id: TerminalId,
    title: string | null | undefined,
  ): Promise<RenameTerminalResult> {
    const fail = (errorCode: RenameTerminalErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'rename_terminal',
        errorCode,
        errorMessage,
      }) satisfies RenameTerminalFailure;
    if (title === undefined) {
      const found = this.terminal(id);
      if (!found.ok) return fail('database_error', found.errorMessage);
      const row = found.data.value;
      if (!row) return fail('terminal_not_found', 'no such terminal');
      return {
        ok: true,
        resultType: 'rename_terminal',
        data: { id, title: row.title },
      } satisfies RenameTerminalSuccess;
    }
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const updated = databaseUpdate('could not save the terminal', () =>
      this.deps.db.run(
        qb
          .updateTable('terminals')
          .set({ title, updated_at: Date.now(), updated_by: actor.username })
          .where('id', '=', id),
      ),
    );
    if (!updated.ok) return fail('database_error', updated.errorMessage);
    if (Number(updated.data.changes) === 0) return fail('terminal_not_found', 'no such terminal');
    return {
      ok: true,
      resultType: 'rename_terminal',
      data: { id, title },
    } satisfies RenameTerminalSuccess;
  }

  /** Persists a full-list reorder: positions become steps of 10. The plan
   *  (same set, each once) is computed by tab-order's pure helper. */
  async reorderTerminals(
    workspaceId: WorkspaceId,
    ordered: TerminalId[],
  ): Promise<ReorderTerminalsResult> {
    const fail = (errorCode: ReorderTerminalsErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'reorder_terminals',
        errorCode,
        errorMessage,
      }) satisfies ReorderTerminalsFailure;
    const found = this.byId(workspaceId);
    if (!found.ok) return fail('database_error', found.errorMessage);
    if (!found.data.value) return fail('workspace_not_found', 'no such workspace');
    const current = databaseRead('could not read terminals', () =>
      this.deps.db
        .all(
          qb
            .selectFrom('terminals')
            .select(['id', 'sort_order'])
            .where('workspace_id', '=', workspaceId),
        )
        .map(row => ({ id: row.id, sortOrder: row.sort_order })),
    );
    if (!current.ok) return fail('database_error', current.errorMessage);
    const plan = reorderUpdates(current.data.value, ordered);
    if (!plan.ok) return fail('invalid_order', plan.message);
    if (plan.updates.length > 0) {
      const actor = this.actor();
      if (!actor.ok) return fail('database_error', actor.errorMessage);
      const now = Date.now();
      for (const update of plan.updates) {
        const updated = databaseUpdate('could not save the terminal order', () =>
          this.deps.db.run(
            qb
              .updateTable('terminals')
              .set({
                sort_order: update.sortOrder,
                updated_at: now,
                updated_by: actor.username,
              })
              .where('id', '=', update.id),
          ),
        );
        if (!updated.ok) return fail('database_error', updated.errorMessage);
      }
      log.info(`workspace ${workspaceId}: ${plan.updates.length} terminal(s) reordered`);
    }
    return {
      ok: true,
      resultType: 'reorder_terminals',
      data: { workspaceId, order: ordered },
    } satisfies ReorderTerminalsSuccess;
  }

  /** Persists a full-list reorder of one group: positions become steps of
   *  10. The plan (same set, each once) is computed by order-plan's pure
   *  helper. */
  async reorderWorkspaces(ordered: WorkspaceId[]): Promise<ReorderWorkspacesResult> {
    const fail = (errorCode: ReorderWorkspacesErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'reorder_workspaces',
        errorCode,
        errorMessage,
      }) satisfies ReorderWorkspacesFailure;
    if (ordered.length === 0) return fail('invalid_order', 'the order is empty');
    const rows = databaseRead('could not read workspaces', () =>
      this.deps.db.all(qb.selectFrom('workspaces').select(['id', 'app_id', 'sort_order'])),
    );
    if (!rows.ok) return fail('database_error', rows.errorMessage);
    // The group is the first listed row's parent; every other id must share
    // it, or orderPlan flags it as not in this group.
    const parent = rows.data.value.find(w => w.id === ordered[0])?.app_id ?? null;
    const group = rows.data.value.filter(w => w.app_id === parent);
    const plan = orderPlan(
      group.map(w => ({ id: w.id, sortOrder: w.sort_order })),
      ordered,
      'workspace',
      'in this group',
    );
    if (!plan.ok) return fail('invalid_order', plan.message);
    if (plan.updates.length > 0) {
      const actor = this.actor();
      if (!actor.ok) return fail('database_error', actor.errorMessage);
      const now = Date.now();
      for (const update of plan.updates) {
        const updated = databaseUpdate('could not save the workspace order', () =>
          this.deps.db.run(
            qb
              .updateTable('workspaces')
              .set({
                sort_order: update.sortOrder,
                updated_at: now,
                updated_by: actor.username,
              })
              .where('id', '=', update.id),
          ),
        );
        if (!updated.ok) return fail('database_error', updated.errorMessage);
      }
      log.info(`${plan.updates.length} workspace(s) reordered in their group`);
    }
    return {
      ok: true,
      resultType: 'reorder_workspaces',
      data: { order: ordered },
    } satisfies ReorderWorkspacesSuccess;
  }

  /** For the WS attach path, with the workspace cwd for respawns and the
   *  build-session framing env (null on a plain workspace). */
  async terminalForAttach(id: TerminalId): Promise<TerminalForAttachResult> {
    const fail = (errorCode: TerminalForAttachErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'terminal_for_attach',
        errorCode,
        errorMessage,
      }) satisfies TerminalForAttachFailure;
    const found = databaseRead(
      'could not read terminal',
      () =>
        this.deps.db.get(
          qb
            .selectFrom('terminals')
            .innerJoin('workspaces', 'workspaces.id', 'terminals.workspace_id')
            .leftJoin('apps', 'apps.id', 'workspaces.app_id')
            .select([
              'terminals.id',
              'terminals.workspace_id',
              'terminals.title',
              'terminals.command',
              'terminals.created_at',
              'workspaces.cwd',
              'workspaces.kind as ws_kind',
              'workspaces.created_at as ws_created_at',
              'apps.slug as app_slug',
              'apps.cwd as app_cwd',
            ])
            .where('terminals.id', '=', id),
        ) ?? null,
    );
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('terminal_not_found', 'no such terminal');
    // A respawned build session must not lose its framing.
    const env =
      row.ws_kind === 'build' && row.app_slug !== null
        ? this.focusEnv('build', row.app_slug, row.app_cwd)
        : null;
    return {
      ok: true,
      resultType: 'terminal_for_attach',
      data: {
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        cwd: row.cwd,
        // The stored command decides; pre-v7 rows (NULL) fall back to the
        // created_at agent-slot derivation.
        agent:
          row.command === 'agent' || (row.command === null && row.created_at === row.ws_created_at),
        env,
      },
    } satisfies TerminalForAttachSuccess;
  }

  /** Flat list; grouping by app is the client's job. */
  async workspaceTree(): Promise<WorkspaceTreeResult> {
    const fail = (errorMessage: string) =>
      ({
        ok: false,
        resultType: 'workspace_tree',
        errorCode: 'database_error',
        errorMessage,
      }) satisfies WorkspaceTreeFailure;
    const workspaces = databaseRead('could not read workspaces', () =>
      this.deps.db.all(
        qb
          .selectFrom('workspaces')
          .select(['id', 'app_id', 'name', 'cwd', 'kind', 'sort_order', 'created_at'])
          .orderBy('sort_order', 'asc')
          .orderBy('created_at', 'asc'),
      ),
    );
    if (!workspaces.ok) return fail(workspaces.errorMessage);
    const terminals = databaseRead('could not read terminals', () =>
      this.deps.db.all(
        qb
          .selectFrom('terminals')
          .select(['id', 'workspace_id', 'title', 'sort_order', 'created_at'])
          .orderBy('sort_order', 'asc')
          .orderBy('created_at', 'asc'),
      ),
    );
    if (!terminals.ok) return fail(terminals.errorMessage);
    const live = await this.deps.liveSessionNames();
    const byWorkspace = new Map<WorkspaceId, WorkspaceState['terminals']>();
    for (const row of workspaces.data.value) byWorkspace.set(row.id, []);
    for (const t of terminals.data.value) {
      const list = byWorkspace.get(t.workspace_id);
      if (list)
        list.push({
          id: t.id,
          title: t.title,
          order: t.sort_order,
          live: live.has(terminalSessionName(t.id)),
        });
    }
    return {
      ok: true,
      resultType: 'workspace_tree',
      data: {
        workspaces: workspaces.data.value.map(w => ({
          id: w.id,
          appId: w.app_id,
          name: w.name,
          cwd: w.cwd,
          kind: w.kind === 'build' ? 'build' : null,
          order: w.sort_order,
          terminals: byWorkspace.get(w.id) ?? [],
        })),
      },
    } satisfies WorkspaceTreeSuccess;
  }
}
