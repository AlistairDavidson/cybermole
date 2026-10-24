// workspaces.ts — the workspace and terminal domain (docs/workspaces-plan.md
// §1–§4). A workspace = a cwd + terminal tabs (+, later, one editor tab);
// it belongs to the console (app_id NULL — the console is NOT an app row)
// or to exactly one app. Terminals live here: a terminal tab is
// meaningless outside its workspace. One terminal tab = one tmux session
// named 't-<uuid>' (derived, never stored — src/lib/tmux.ts); the state db
// owns the identity, and the row exists even when the tmux spawn fails
// (plan §4: a dead tab — the first attach retries the spawn).
//
// Constructed once per process (services.ts, fed by server/main.ts) and
// reached by routes through locals.cybermole (docs/CODE_STYLE.md §6).
// Deletion cascades through FKs; the deleted terminals' tmux sessions are
// killed best-effort, logged, never failing the delete.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { qb, type StateDb } from './db';
import { databaseRead, databaseUpdate, type DatabaseReadResult } from '@cybermole/app-kit';
import { componentLogger } from './logger';
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
import type { WorkspaceState } from './types';
import type { TmuxSessionFailure, TmuxSessionSuccess } from './tmux';

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
  'invalid_name' | 'invalid_cwd' | 'app_not_found' | 'workspace_not_found' | 'database_error';
export type SaveWorkspaceSuccess = ResultSuccess<'save_workspace', SaveWorkspaceData>;
export type SaveWorkspaceFailure = ResultFailure<
  'save_workspace',
  SaveWorkspaceData,
  SaveWorkspaceErrorCode
>;
export type SaveWorkspaceResult = SaveWorkspaceSuccess | SaveWorkspaceFailure;

export type DeleteWorkspaceData = { id: WorkspaceId };
/** workspace_not_found: no workspace with that id. The best-effort tmux
 *  kills of its terminals' sessions are logged and never turn a
 *  successful delete into a failure. */
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
/** workspace_not_found: no workspace to hold the tab. server_not_running /
 *  tmux_error: the spawn's never-fork guard / tmux failure — the row was
 *  STILL created and rides along on the failure's data (live:false, plan
 *  §4): the tab exists, the UI shows it dead, the first attach retries
 *  the spawn. database_error: the insert failed (no row). */
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

/** What server/main.ts's WS attach path needs for one terminal tab: the
 *  row + its workspace's cwd (the respawn dir — plan §4). `agent`: the
 *  row IS the workspace's auto-opened agent tab (task/defaults-settings,
 *  recognised by created_at equality with the workspace — only a tab
 *  created inside the create holds that exact timestamp), so the respawn
 *  re-runs the AGENT command for it and the shell command for every
 *  other tab, exactly like the spawns that created them. */
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

/** GET /api/state's workspace half (plan §5): every workspace row, flat,
 *  each with its terminals and their live flags — the live diff against
 *  tmux's session-name set (`t-<uuid>` present = live). */
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

/** The cwd check, same shape as zed.ts's: absolute + a directory the
 *  server can see. About typos, not access control — the caller holds
 *  the session cookie, which is already a shell at this privilege.
 *  Exported for apps.ts: an app's cwd is a workspace-start default, so
 *  it passes the same rule (task/app-cwd). */
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

// ---------- the domain ----------

export interface WorkspacesDeps {
  db: StateDb;
  /** The single credential row's username — created_by/updated_by
   *  (plan §2), read through services (Auth.username). */
  username: () => DatabaseReadResult<string | null>;
  /** Best-effort tmux kill for a closed/deleted terminal's session. */
  killSession: (name: TmuxSessionName) => Promise<boolean>;
  /** Start a terminal tab's tmux session (tmux.newSession wired in
   *  services.ts with the configured command + sessionEnv). Injected so
   *  the domain stays unit-testable without a tmux server; its failures
   *  (server_not_running / tmux_error) map straight onto new_terminal's
   *  family (plan §4). */
  spawnSession: (
    name: TmuxSessionName,
    cwd: string,
    command: string[],
  ) => Promise<TmuxSessionSuccess | TmuxSessionFailure>;
  /** The resolved SHELL command line — what every new tab EXCEPT a new
   *  workspace's first runs (db override ?? CYBERMOLE_COMMAND —
   *  task/defaults-settings). Injected like spawnSession so the domain
   *  stays unit-testable; read per spawn, so a /settings save applies
   *  without a restart. */
  shellCommand: () => DatabaseReadResult<string>;
  /** The resolved AGENT command line — what the auto-opened first tab of
   *  a NEW workspace runs (db ?? CYBERMOLE_AGENT_COMMAND ?? the vendored
   *  pi — src/lib/terminal-defaults.ts). */
  agentCommand: () => DatabaseReadResult<string>;
  /** CYBERMOLE_NEW_SESSION_CWD — the default when the create carries no cwd
   *  of its own AND the parent app has none (plan §6, task/app-cwd). */
  defaultCwd: string;
  /** Live tmux session names (tmux.liveSessionNames) — the tree read's
   *  live diff (`t-<uuid>` present = the tab is live, plan §5). Injected
   *  so the domain stays unit-testable without a tmux server; it can't
   *  fail (a down server reads as "nothing live"). */
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

  /** max(sort_order) + 10 among one parent's children — allocation in
   *  steps of 10, per group (plan §2). */
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

  /** Create a workspace. The cwd is DERIVED (task/app-cwd: no folder
   *  setting at the dialog or on the wire — the app does that): an
   *  explicit one (an internal caller; the POST body no longer carries
   *  one) wins, then the parent app's cwd, then the configured default
   *  (CYBERMOLE_NEW_SESSION_CWD). Whatever wins is validated (absolute +
   *  existing dir) — the parent app's cwd included: the dir may have
   *  gone since the app was saved. */
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
      // Pre-check the FK (constraint violations are closed error codes,
      // never message-sniffed — plan §2); the residual race degrades to
      // database_error at the insert. The same read carries the app's cwd
      // — the create-side default below (task/app-cwd).
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
    // task/defaults-settings: a NEW workspace auto-opens its FIRST
    // terminal — the agent slot — running the resolved agent command,
    // created through the same row-then-spawn contract as the + button
    // (plan §4): the row lands even when the spawn fails (a dead tab,
    // retried by the first attach), and a failed auto-open can never
    // fail the CREATE — a workspace without its agent tab beats no
    // workspace. The row carries the WORKSPACE's created_at (`now`
    // below): only a tab created inside the create can hold that exact
    // timestamp, which is how the attach path recognises the agent slot
    // for respawns (terminalForAttach's `agent`) — stable where
    // first-by-sort_order would drift (closing the agent tab would
    // re-flag whatever became first).
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

  /** Patch a workspace: name and/or cwd, absent fields keep. */
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

  /** Delete a workspace: the FK cascades its terminals; their tmux
   *  sessions are killed best-effort afterwards — a kill can never fail
   *  the delete. */
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

  /** Open a new terminal tab (plan §4): insert the row (sort_order =
   *  max+10), then best-effort-spawn its tmux session at the workspace
   *  cwd. Rows never block on tmux: when the spawn fails the row still
   *  exists — the failure carries it (live:false), the UI shows a dead
   *  tab and the first attach retries the spawn. No eager spawns at
   *  boot; closing kills the session best-effort, never failing on it.
   *  The tab runs the SHELL command (task/defaults-settings); the
   *  workspace create's auto-open (the agent slot) shares openTab. */
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
    // A + button tab must NEVER share its workspace's created_at — that
    // equality IS the agent-slot mark (terminalForAttach). A human's +
    // click is always a later tick, but a scripted client can land its
    // next request in the same millisecond; the stamp never goes
    // backwards (clock skew) and always advances past the workspace's.
    const createdAt = Math.max(Date.now(), row.created_at + 1);
    return this.openTab(workspaceId, row.cwd, title, this.deps.shellCommand(), createdAt);
  }

  /** The shared row-then-spawn half of newTerminal and the workspace
   *  create's auto-open (plan §4): resolve the command (the caller picks
   *  the slot's own — shell vs agent — at create time, so a /settings
   *  save applies to the very next tab), insert the row, then
   *  best-effort spawn at `cwd` running the split argv. The row ALWAYS
   *  lands before the spawn is attempted; a spawn failure carries it
   *  (live:false). A failed command READ (database_error) precedes the
   *  insert, so no row exists — the same shape new_terminal gives a db
   *  failure. `createdAt` stamps the row — the workspace create passes
   *  ITS OWN timestamp so the auto-opened row is recognisable later
   *  (terminalForAttach's `agent`). */
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
      // The row exists even when the spawn fails (plan §4) — report the
      // code, carry the row: a dead tab, retried by the first attach.
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

  /** Close a terminal tab: delete the row, then best-effort-kill its
   *  session (derived name). No graveyard, no history (plan §4). */
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

  /** Rename a terminal tab — title null clears it back to the "term N"
   *  label; an absent title is a no-op that returns the row (the {title?}
   *  convention of the app/workspace patches). The title's shape was
   *  validated at the request boundary. */
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

  /** The row + workspace cwd for one terminal tab — server/main.ts's WS
   *  attach path (task/ws-terminal, plan §4: never-fork guard → respawn
   *  if dead → attach -d). Read-only; joins the workspace for the cwd and
   *  adds `agent` (the auto-opened slot — task/defaults-settings) so the
   *  respawn re-runs the command the tab's slot runs. */
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
    // The agent-slot test (task/defaults-settings): the auto-opened row
    // carries its workspace's EXACT created_at (saveWorkspace passes its
    // own `now`), and no other row can — a + button tab is always a later
    // tick. Closing the agent tab therefore leaves nothing flagged (a
    // first-by-sort_order check would re-flag whichever tab became
    // first and respawn the agent command into a shell tab).
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

  /** GET /api/state's tree read + live diff (plan §5): every workspace
   *  flat with appId (grouping is the client's), its terminals in order,
   *  each live flag from one tmux name-set lookup. */
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
