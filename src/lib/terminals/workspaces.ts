// Workspaces (a cwd + terminal tabs) belong to the console (app_id NULL) or
// one app. Each terminal tab is a tmux session 't-<uuid>', derived from the
// row id. The row exists even when the spawn fails; the first attach retries.
// Deletes cascade through FKs; tmux kills are best-effort.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { qb, type StateDb } from '../platform/db';
import { databaseRead, databaseUpdate, type DatabaseReadResult } from '@cybermole/app-kit';
import { componentLogger } from '../platform/logger';
import { terminalSessionName } from './tmux';
import { splitCommandLine } from './terminal-defaults';
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

export type SaveWorkspaceData = { id: WorkspaceId; appId: AppId | null; name: string; cwd: string };
/** invalid_cwd: not absolute or not an existing directory. app_not_found
 *  is pre-checked; the check-then-insert race degrades to database_error. */
export type SaveWorkspaceErrorCode =
  'invalid_name' | 'invalid_cwd' | 'app_not_found' | 'workspace_not_found' | 'database_error';
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

/** `agent`: this is the workspace's auto-opened agent tab, so a respawn
 *  runs the agent command rather than the shell. */
export type TerminalForAttachData = {
  id: TerminalId;
  workspaceId: WorkspaceId;
  title: string | null;
  cwd: string;
  agent: boolean;
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
  /** Injected so the domain is testable without tmux. */
  spawnSession: (
    name: TmuxSessionName,
    cwd: string,
    command: string[],
  ) => Promise<TmuxSessionSuccess | TmuxSessionFailure>;
  /** The shell command for new tabs; read per spawn so /settings applies immediately. */
  shellCommand: () => DatabaseReadResult<string>;
  /** The agent command for a new workspace's first tab. */
  agentCommand: () => DatabaseReadResult<string>;
  /** Used when neither the create nor the parent app gives a cwd. */
  defaultCwd: string;
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
            .select(['id', 'app_id', 'name', 'cwd', 'created_at'])
            .where('id', '=', id),
        ) ?? null,
    );
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

  /** cwd: explicit, else the parent app's, else the default. Validated
   *  either way, since the app's dir may have gone since it was saved. */
  async saveWorkspace(input: {
    appId?: AppId | null;
    name: string;
    cwd?: string;
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
    let parentCwd: string | null = null;
    if (appId !== null) {
      // Pre-check the FK so it's a closed code; also reads the app's cwd.
      const parent = databaseRead(
        'could not read app',
        () =>
          this.deps.db.get(qb.selectFrom('apps').select(['id', 'cwd']).where('id', '=', appId)) ??
          null,
      );
      if (!parent.ok) return fail('database_error', parent.errorMessage);
      if (!parent.data.value) return fail('app_not_found', 'no such app');
      parentCwd = parent.data.value.cwd;
    }
    const wanted = input.cwd !== undefined ? input.cwd : (parentCwd ?? this.deps.defaultCwd);
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
      `workspace "${name}" created (cwd ${cwd.cwd}${appId === null ? ', console' : `, app ${appId}`})`,
    );
    // A new workspace auto-opens its agent tab. A failed spawn never fails
    // the create. The tab gets the workspace's exact created_at, which is
    // how terminalForAttach recognises the agent slot (stable, unlike
    // "first by sort_order", which would drift when the tab is closed).
    const opened = await this.openTab(id, cwd.cwd, undefined, this.deps.agentCommand(), now);
    if (!opened.ok)
      log.warn(
        `workspace "${name}": its first terminal did not start ` +
          `(${opened.errorCode}: ${opened.errorMessage}) — the tab is there, the first attach retries`,
      );
    return {
      ok: true,
      resultType: 'save_workspace',
      data: { id, appId, name, cwd: cwd.cwd },
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
        data: { id: row.id, appId: row.app_id, name: row.name, cwd: row.cwd },
      } satisfies SaveWorkspaceSuccess;
    }
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
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
   *  returns the row (live:false) for the first attach to retry. */
  async newTerminal(
    workspaceId: WorkspaceId,
    title: string | undefined,
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
    // created_at equal to the workspace's marks the agent slot, so a +
    // tab must be strictly later (a script can land in the same ms).
    const createdAt = Math.max(Date.now(), row.created_at + 1);
    return this.openTab(workspaceId, row.cwd, title, this.deps.shellCommand(), createdAt);
  }

  /** Row first, then the spawn. A failed command read returns before the
   *  insert, so no row. */
  private async openTab(
    workspaceId: WorkspaceId,
    cwd: string,
    title: string | null | undefined,
    command: DatabaseReadResult<string>,
    createdAt: number,
  ): Promise<NewTerminalResult> {
    const fail = (errorCode: NewTerminalErrorCode, errorMessage: string, data?: NewTerminalData) =>
      ({
        ok: false,
        resultType: 'new_terminal',
        errorCode,
        errorMessage,
        ...(data ? { data } : {}),
      }) satisfies NewTerminalFailure;
    if (!command.ok)
      return fail('database_error', command.errorMessage ?? 'could not read the terminal command');
    const argv = splitCommandLine(command.data.value);
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
          created_at: now,
          updated_at: now,
          created_by: actor.username,
          updated_by: actor.username,
        }),
      ),
    );
    if (!inserted.ok) return fail('database_error', inserted.errorMessage);
    const data: NewTerminalData = { id, workspaceId, title: title ?? null, live: false };
    const spawned = await this.deps.spawnSession(terminalSessionName(id), cwd, argv);
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

  /** For the WS attach path, with the workspace cwd for respawns. */
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
            .select([
              'terminals.id',
              'terminals.workspace_id',
              'terminals.title',
              'terminals.created_at',
              'workspaces.cwd',
              'workspaces.created_at as ws_created_at',
            ])
            .where('terminals.id', '=', id),
        ) ?? null,
    );
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('terminal_not_found', 'no such terminal');
    return {
      ok: true,
      resultType: 'terminal_for_attach',
      data: {
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        cwd: row.cwd,
        agent: row.created_at === row.ws_created_at,
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
          .select(['id', 'app_id', 'name', 'cwd', 'sort_order', 'created_at'])
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
          order: w.sort_order,
          terminals: byWorkspace.get(w.id) ?? [],
        })),
      },
    } satisfies WorkspaceTreeSuccess;
  }
}
