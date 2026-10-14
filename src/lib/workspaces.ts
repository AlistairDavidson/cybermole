// workspaces.ts — the workspace and terminal domain (docs/workspaces-plan.md
// §1–§4). A workspace = a cwd + terminal tabs (+, later, one editor tab);
// it belongs to the console (app_id NULL — the console is NOT an app row)
// or to exactly one app. Terminals live here: a terminal tab is
// meaningless outside its workspace. One terminal tab = one tmux session
// named 't-<uuid>' (derived, never stored — src/lib/tmux.ts), but the
// state db owns the identity; in THIS branch (task/ws-schema) terminal
// rows are inserted without spawning — the tmux wiring is task/ws-terminal.
//
// Constructed once per process (services.ts, fed by server/main.ts) and
// reached by routes through locals.webpi (docs/CODE_STYLE.md §6).
// Deletion cascades through FKs; the deleted terminals' tmux sessions are
// killed best-effort, logged, never failing the delete.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { databaseRead, databaseUpdate, qb, type DatabaseReadResult, type StateDb } from './db';
import { componentLogger } from './logger';
import { terminalSessionName } from './tmux';
import type { ResultFailure, ResultSuccess } from '../types/result';
import type { AppId, TerminalId, TmuxSessionName, WorkspaceId } from '../types/branded';
import { asTerminalId, asWorkspaceId } from '../types/branded';

const log = componentLogger('workspaces');

// ---------- results (HTTP statuses are mapped in responses.service.ts) ----------

export type SaveWorkspaceData = { id: WorkspaceId; appId: AppId | null; name: string; cwd: string };
/** invalid_name: an empty (or whitespace-only) name. invalid_cwd: not an
 *  absolute path, or not an existing directory (the zed.ts check — typos,
 *  not access control). app_not_found: a create under an app that doesn't
 *  exist (pre-checked). workspace_not_found: a patch/delete of an id that
 *  no longer resolves (the plan's §3 list predates the PATCH route; the
 *  code is added so a missing workspace is a 404, not a 500).
 *  database_error: the state db failed (also the residual
 *  check-then-insert race's answer). */
export type SaveWorkspaceErrorCode =
  | 'invalid_name' | 'invalid_cwd' | 'app_not_found' | 'workspace_not_found' | 'database_error';
export type SaveWorkspaceSuccess = ResultSuccess<'save_workspace', SaveWorkspaceData>;
export type SaveWorkspaceFailure = ResultFailure<'save_workspace', SaveWorkspaceData, SaveWorkspaceErrorCode>;
export type SaveWorkspaceResult = SaveWorkspaceSuccess | SaveWorkspaceFailure;

export type DeleteWorkspaceData = { id: WorkspaceId };
/** workspace_not_found: no workspace with that id. The best-effort tmux
 *  kills of its terminals' sessions are logged and never turn a
 *  successful delete into a failure. */
export type DeleteWorkspaceErrorCode = 'workspace_not_found' | 'database_error';
export type DeleteWorkspaceSuccess = ResultSuccess<'delete_workspace', DeleteWorkspaceData>;
export type DeleteWorkspaceFailure = ResultFailure<'delete_workspace', DeleteWorkspaceData, DeleteWorkspaceErrorCode>;
export type DeleteWorkspaceResult = DeleteWorkspaceSuccess | DeleteWorkspaceFailure;

export type NewTerminalData = { id: TerminalId; workspaceId: WorkspaceId; title: string | null; live: boolean };
/** workspace_not_found: no workspace to hold the tab. server_not_running /
 *  tmux_error: the spawn's never-fork guard / tmux failure — unreachable
 *  until the spawn lands (task/ws-terminal, plan §4) but part of the
 *  closed union now: the row exists even when the spawn fails, and
 *  tmux_error still reports. database_error: the insert failed. */
export type NewTerminalErrorCode = 'workspace_not_found' | 'server_not_running' | 'tmux_error' | 'database_error';
export type NewTerminalSuccess = ResultSuccess<'new_terminal', NewTerminalData>;
export type NewTerminalFailure = ResultFailure<'new_terminal', NewTerminalData, NewTerminalErrorCode>;
export type NewTerminalResult = NewTerminalSuccess | NewTerminalFailure;

export type CloseTerminalData = { id: TerminalId };
export type CloseTerminalErrorCode = 'terminal_not_found' | 'database_error';
export type CloseTerminalSuccess = ResultSuccess<'close_terminal', CloseTerminalData>;
export type CloseTerminalFailure = ResultFailure<'close_terminal', CloseTerminalData, CloseTerminalErrorCode>;
export type CloseTerminalResult = CloseTerminalSuccess | CloseTerminalFailure;

export type RenameTerminalData = { id: TerminalId; title: string | null };
export type RenameTerminalErrorCode = 'terminal_not_found' | 'database_error';
export type RenameTerminalSuccess = ResultSuccess<'rename_terminal', RenameTerminalData>;
export type RenameTerminalFailure = ResultFailure<'rename_terminal', RenameTerminalData, RenameTerminalErrorCode>;
export type RenameTerminalResult = RenameTerminalSuccess | RenameTerminalFailure;

/** What server/main.ts's WS attach path needs for one terminal tab: the
 *  row + its workspace's cwd (the respawn dir — plan §4). */
export type TerminalForAttachData = { id: TerminalId; workspaceId: WorkspaceId; title: string | null; cwd: string };
export type TerminalForAttachErrorCode = 'terminal_not_found' | 'database_error';
export type TerminalForAttachSuccess = ResultSuccess<'terminal_for_attach', TerminalForAttachData>;
export type TerminalForAttachFailure = ResultFailure<'terminal_for_attach', TerminalForAttachData, TerminalForAttachErrorCode>;
export type TerminalForAttachResult = TerminalForAttachSuccess | TerminalForAttachFailure;

// ---------- helpers ----------

/** The cwd check, same shape as zed.ts's: absolute + a directory the
 *  server can see. About typos, not access control — the caller holds
 *  the session cookie, which is already a shell at this privilege. */
function checkedCwd(cwd: string): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (!cwd.startsWith('/')) return { ok: false, reason: `cwd must be an absolute path: ${cwd}` };
  try {
    if (!fs.statSync(cwd).isDirectory()) return { ok: false, reason: `cwd is not a directory: ${cwd}` };
  } catch {
    return { ok: false, reason: `cwd does not exist: ${cwd}` };
  }
  return { ok: true, cwd };
}

// ---------- the domain ----------

export interface WorkspacesDeps {
  db: StateDb;
  /** The single credential row's username — created_by/updated_by
   *  (plan §2), read through services (Auth.username). */
  username: () => DatabaseReadResult<string | null>;
  /** Best-effort tmux kill for a closed/deleted terminal's session. */
  killSession: (name: TmuxSessionName) => Promise<boolean>;
  /** WEB_PI_NEW_SESSION_CWD — the default when POST /api/workspaces omits
   *  cwd (plan §6). */
  defaultCwd: string;
  /** env for processes spawned inside tmux sessions — unused until the
   *  spawn lands (junction below), carried from ServiceDeps now so
   *  task/ws-terminal wires it in one place. */
  sessionEnv: Record<string, string>;
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
    return databaseRead('could not read workspace', () =>
      this.deps.db.get(qb.selectFrom('workspaces')
        .select(['id', 'app_id', 'name', 'cwd']).where('id', '=', id)) ?? null);
  }

  private terminal(id: TerminalId) {
    return databaseRead('could not read terminal', () =>
      this.deps.db.get(qb.selectFrom('terminals').select(['id', 'workspace_id', 'title']).where('id', '=', id)) ?? null);
  }

  /** max(sort_order) + 10 among one parent's children — allocation in
   *  steps of 10, per group (plan §2). */
  private nextOrder(appId: AppId | null) {
    return databaseRead('could not read workspace order', () =>
      (this.deps.db.get(qb.selectFrom('workspaces').select(eb => eb.fn.max<number | null>('sort_order').as('max'))
        .where('app_id', 'is', appId))?.max ?? 0) + 10);
  }

  /** Create a workspace. cwd defaults to the configured new-session cwd;
   *  an explicit one is validated (absolute + existing dir). */
  async saveWorkspace(input: { appId?: AppId | null; name: string; cwd?: string }): Promise<SaveWorkspaceResult> {
    const fail = (errorCode: SaveWorkspaceErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'save_workspace', errorCode, errorMessage }) satisfies SaveWorkspaceFailure;
    const name = input.name.trim();
    if (!name) return fail('invalid_name', 'name is required');
    const cwd = checkedCwd(input.cwd === undefined ? this.deps.defaultCwd : input.cwd);
    if (!cwd.ok) return fail('invalid_cwd', cwd.reason);
    const appId = input.appId ?? null;
    if (appId !== null) {
      // Pre-check the FK (constraint violations are closed error codes,
      // never message-sniffed — plan §2); the residual race degrades to
      // database_error at the insert.
      const parent = databaseRead('could not read app', () =>
        this.deps.db.get(qb.selectFrom('apps').select('id').where('id', '=', appId)) ?? null);
      if (!parent.ok) return fail('database_error', parent.errorMessage);
      if (!parent.data.value) return fail('app_not_found', 'no such app');
    }
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const order = this.nextOrder(appId);
    if (!order.ok) return fail('database_error', order.errorMessage);
    const id = asWorkspaceId(randomUUID());
    const now = Date.now();
    const inserted = databaseUpdate('could not save the workspace', () =>
      this.deps.db.run(qb.insertInto('workspaces').values({
        id, app_id: appId, name, cwd: cwd.cwd, sort_order: order.data.value,
        created_at: now, updated_at: now, created_by: actor.username, updated_by: actor.username,
      })));
    if (!inserted.ok) return fail('database_error', inserted.errorMessage);
    log.info(`workspace "${name}" created (cwd ${cwd.cwd}${appId === null ? ', console' : `, app ${appId}`})`);
    return { ok: true, resultType: 'save_workspace', data: { id, appId, name, cwd: cwd.cwd } } satisfies SaveWorkspaceSuccess;
  }

  /** Patch a workspace: name and/or cwd, absent fields keep. */
  async updateWorkspace(id: WorkspaceId, input: { name?: string; cwd?: string }): Promise<SaveWorkspaceResult> {
    const fail = (errorCode: SaveWorkspaceErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'save_workspace', errorCode, errorMessage }) satisfies SaveWorkspaceFailure;
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
        ok: true, resultType: 'save_workspace',
        data: { id: row.id, appId: row.app_id, name: row.name, cwd: row.cwd },
      } satisfies SaveWorkspaceSuccess;
    }
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const updated = databaseUpdate('could not save the workspace', () =>
      this.deps.db.run(qb.updateTable('workspaces').set({
        ...(name === undefined ? {} : { name }),
        ...(cwd === undefined ? {} : { cwd: cwd.cwd }),
        updated_at: Date.now(), updated_by: actor.username,
      }).where('id', '=', id)));
    if (!updated.ok) return fail('database_error', updated.errorMessage);
    return {
      ok: true, resultType: 'save_workspace',
      data: { id, appId: row.app_id, name: name ?? row.name, cwd: cwd === undefined ? row.cwd : cwd.cwd },
    } satisfies SaveWorkspaceSuccess;
  }

  /** Delete a workspace: the FK cascades its terminals; their tmux
   *  sessions are killed best-effort afterwards — a kill can never fail
   *  the delete. */
  async deleteWorkspace(id: WorkspaceId): Promise<DeleteWorkspaceResult> {
    const fail = (errorCode: DeleteWorkspaceErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'delete_workspace', errorCode, errorMessage }) satisfies DeleteWorkspaceFailure;
    const found = this.byId(id);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('workspace_not_found', 'no such workspace');
    const terminals = databaseRead('could not read terminals', () =>
      this.deps.db.all(qb.selectFrom('terminals').select('id').where('workspace_id', '=', id)));
    if (!terminals.ok) return fail('database_error', terminals.errorMessage);
    const deleted = databaseUpdate('could not delete the workspace', () =>
      this.deps.db.run(qb.deleteFrom('workspaces').where('id', '=', id)));
    if (!deleted.ok) return fail('database_error', deleted.errorMessage);
    for (const t of terminals.data.value) await this.deps.killSession(terminalSessionName(t.id));
    log.info(`workspace "${row.name}" deleted (${terminals.data.value.length} terminal sessions killed best-effort)`);
    return { ok: true, resultType: 'delete_workspace', data: { id } } satisfies DeleteWorkspaceSuccess;
  }

  /** Open a new terminal tab: insert the row (sort_order = max+10), live
   *  false — the tmux session is spawned by the ATTACH path, and until
   *  task/ws-terminal lands there is no spawn at all. */
  async newTerminal(workspaceId: WorkspaceId, title: string | undefined): Promise<NewTerminalResult> {
    const fail = (errorCode: NewTerminalErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'new_terminal', errorCode, errorMessage }) satisfies NewTerminalFailure;
    const found = this.byId(workspaceId);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('workspace_not_found', 'no such workspace');
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const order = databaseRead('could not read terminal order', () =>
      (this.deps.db.get(qb.selectFrom('terminals').select(eb => eb.fn.max<number | null>('sort_order').as('max'))
        .where('workspace_id', '=', workspaceId))?.max ?? 0) + 10);
    if (!order.ok) return fail('database_error', order.errorMessage);
    const id = asTerminalId(randomUUID());
    const now = Date.now();
    const inserted = databaseUpdate('could not save the terminal', () =>
      this.deps.db.run(qb.insertInto('terminals').values({
        id, workspace_id: workspaceId, title: title ?? null, sort_order: order.data.value,
        created_at: now, updated_at: now, created_by: actor.username, updated_by: actor.username,
      })));
    if (!inserted.ok) return fail('database_error', inserted.errorMessage);
    // junction(task/ws-terminal): best-effort tmux spawn lands here (plan
    // §4) — `new-session -d -s t-<uuid> -c <workspace cwd>` with
    // deps.sessionEnv and the configured command; the row exists even
    // when the spawn fails (a dead tab), so live stays false on any
    // spawn failure and this branch's insert-only shape is already that
    // contract's degenerate case.
    return {
      ok: true, resultType: 'new_terminal',
      data: { id, workspaceId, title: title ?? null, live: false },
    } satisfies NewTerminalSuccess;
  }

  /** Close a terminal tab: delete the row, then best-effort-kill its
   *  session (derived name). No graveyard, no history (plan §4). */
  async closeTerminal(id: TerminalId): Promise<CloseTerminalResult> {
    const fail = (errorCode: CloseTerminalErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'close_terminal', errorCode, errorMessage }) satisfies CloseTerminalFailure;
    const found = this.terminal(id);
    if (!found.ok) return fail('database_error', found.errorMessage);
    if (!found.data.value) return fail('terminal_not_found', 'no such terminal');
    const deleted = databaseUpdate('could not delete the terminal', () =>
      this.deps.db.run(qb.deleteFrom('terminals').where('id', '=', id)));
    if (!deleted.ok) return fail('database_error', deleted.errorMessage);
    await this.deps.killSession(terminalSessionName(id));
    return { ok: true, resultType: 'close_terminal', data: { id } } satisfies CloseTerminalSuccess;
  }

  /** Rename a terminal tab — title null clears it back to the "term N"
   *  label; an absent title is a no-op that returns the row (the {title?}
   *  convention of the app/workspace patches). The title's shape was
   *  validated at the request boundary. */
  async renameTerminal(id: TerminalId, title: string | null | undefined): Promise<RenameTerminalResult> {
    const fail = (errorCode: RenameTerminalErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'rename_terminal', errorCode, errorMessage }) satisfies RenameTerminalFailure;
    if (title === undefined) {
      const found = this.terminal(id);
      if (!found.ok) return fail('database_error', found.errorMessage);
      const row = found.data.value;
      if (!row) return fail('terminal_not_found', 'no such terminal');
      return { ok: true, resultType: 'rename_terminal', data: { id, title: row.title } } satisfies RenameTerminalSuccess;
    }
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const updated = databaseUpdate('could not save the terminal', () =>
      this.deps.db.run(qb.updateTable('terminals')
        .set({ title, updated_at: Date.now(), updated_by: actor.username })
        .where('id', '=', id)));
    if (!updated.ok) return fail('database_error', updated.errorMessage);
    if (Number(updated.data.changes) === 0) return fail('terminal_not_found', 'no such terminal');
    return { ok: true, resultType: 'rename_terminal', data: { id, title } } satisfies RenameTerminalSuccess;
  }

  /** The row + workspace cwd for one terminal tab — server/main.ts's WS
   *  attach path (task/ws-terminal, plan §4: never-fork guard → respawn
   *  if dead → attach -d). Read-only; joins the workspace for the cwd. */
  async terminalForAttach(id: TerminalId): Promise<TerminalForAttachResult> {
    const fail = (errorCode: TerminalForAttachErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'terminal_for_attach', errorCode, errorMessage }) satisfies TerminalForAttachFailure;
    const found = databaseRead('could not read terminal', () =>
      this.deps.db.get(qb.selectFrom('terminals')
        .innerJoin('workspaces', 'workspaces.id', 'terminals.workspace_id')
        .select(['terminals.id', 'terminals.workspace_id', 'terminals.title', 'workspaces.cwd'])
        .where('terminals.id', '=', id)) ?? null);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('terminal_not_found', 'no such terminal');
    return {
      ok: true, resultType: 'terminal_for_attach',
      data: { id: row.id, workspaceId: row.workspace_id, title: row.title, cwd: row.cwd },
    } satisfies TerminalForAttachSuccess;
  }
}
