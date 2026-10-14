// apps.ts — the app domain (docs/workspaces-plan.md §1–§3): a named,
// slug'd, ordered container for workspaces. Barebones on purpose — the
// workspace/terminal structure lives in workspaces.ts; apps are the
// grouping, the ordering and the URL identity (slug, stable once
// created). Constructed once per process (services.ts, fed by
// server/main.ts) and reached by routes through locals.webpi — never
// runtime-imported by Astro code (docs/CODE_STYLE.md §6).
//
// Deletion is cascade-first: the FK chain (apps → workspaces → terminals,
// ON DELETE CASCADE) does the structural delete in one statement (PRAGMA
// foreign_keys is set at open, src/lib/db.ts), and the deleted terminals'
// tmux sessions are then killed best-effort — derived 't-<uuid>' names,
// never stored — logged, never failing the delete. Jobs are untouched:
// jobs.app_id is a TAG (ON DELETE SET NULL), not ownership.
import { randomUUID } from 'node:crypto';
import { databaseRead, databaseUpdate, qb, type StateDb } from './db';
import { componentLogger } from './logger';
import { terminalSessionName } from './tmux';
import type { DatabaseReadResult } from './db';
import type { ResultFailure, ResultSuccess } from '../types/result';
import type { AppId, AppSlug, TmuxSessionName } from '../types/branded';
import { asAppId, asAppSlug } from '../types/branded';
import { APP_SLUG_RE, normalizeSlug } from '../schemas/patterns';

const log = componentLogger('apps');

// ---------- results (HTTP statuses are mapped in responses.service.ts) ----------

export type SaveAppData = { id: AppId; name: string; slug: AppSlug };
/** invalid_name: the display name is empty, or slugs to nothing usable.
 *  duplicate_slug: the derived slug is taken (pre-checked, not
 *  message-sniffed — plan §2). app_not_found: rename of a slug that no
 *  longer resolves (the plan's §3 list predates the PATCH route; the code
 *  is added so a missing app is a 404, not a 500). database_error: the
 *  state db failed (also the residual pre-check/insert race's answer). */
export type SaveAppErrorCode = 'invalid_name' | 'duplicate_slug' | 'app_not_found' | 'database_error';
export type SaveAppSuccess = ResultSuccess<'save_app', SaveAppData>;
export type SaveAppFailure = ResultFailure<'save_app', SaveAppData, SaveAppErrorCode>;
export type SaveAppResult = SaveAppSuccess | SaveAppFailure;

export type DeleteAppData = { id: AppId };
/** app_not_found: no app with that slug. The best-effort tmux kills are
 *  logged (src/lib/tmux.ts) and never turn a successful delete into a
 *  failure. */
export type DeleteAppErrorCode = 'app_not_found' | 'database_error';
export type DeleteAppSuccess = ResultSuccess<'delete_app', DeleteAppData>;
export type DeleteAppFailure = ResultFailure<'delete_app', DeleteAppData, DeleteAppErrorCode>;
export type DeleteAppResult = DeleteAppSuccess | DeleteAppFailure;

/** task/ws-jobs (plan §9): the app picker's options — one read, the
 *  display fields only (the jobs dialog tags with the id). */
export interface AppOption {
  id: AppId;
  name: string;
  slug: AppSlug;
  order: number;
}
export type ListAppsData = { apps: AppOption[] };
export type ListAppsErrorCode = 'database_error';
export type ListAppsSuccess = ResultSuccess<'list_apps', ListAppsData>;
export type ListAppsFailure = ResultFailure<'list_apps', ListAppsData, ListAppsErrorCode>;
export type ListAppsResult = ListAppsSuccess | ListAppsFailure;

// ---------- the domain ----------

export interface AppsDeps {
  db: StateDb;
  /** The single credential row's username — created_by/updated_by
   *  (plan §2), read through services (Auth.username). */
  username: () => DatabaseReadResult<string | null>;
  /** Best-effort tmux kill for a deleted terminal's session. */
  killSession: (name: TmuxSessionName) => Promise<boolean>;
}

export class Apps {
  constructor(private deps: AppsDeps) {}

  /** Who writes rows: the credential username. A missing credential
   *  cannot happen on an authenticated route (login requires it) —
   *  'unknown' keeps the write honest if it ever does. */
  private actor(): { ok: true; username: string } | { ok: false; errorMessage: string } {
    const who = this.deps.username();
    return who.ok
      ? { ok: true, username: who.data.value ?? 'unknown' }
      : { ok: false, errorMessage: who.errorMessage ?? 'could not read the credential' };
  }

  /** max(sort_order) + 10 — order allocation in steps of 10 (plan §2). */
  private nextOrder() {
    return databaseRead('could not read app order', () =>
      (this.deps.db.get(qb.selectFrom('apps').select(eb => eb.fn.max<number | null>('sort_order').as('max')))?.max ?? 0) + 10);
  }

  private bySlug(slug: AppSlug) {
    return databaseRead('could not read app', () =>
      this.deps.db.get(qb.selectFrom('apps').select(['id', 'name']).where('slug', '=', slug)) ?? null);
  }

  /** Create an app: the slug is DERIVED (normalizeSlug) and checked
   *  against the table before the insert — constraint violations are
   *  closed error codes, never message-sniffed (plan §2); the residual
   *  check-then-insert race degrades to database_error. */
  async saveApp(name: string): Promise<SaveAppResult> {
    const fail = (errorCode: SaveAppErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'save_app', errorCode, errorMessage }) satisfies SaveAppFailure;
    const trimmed = name.trim();
    if (!trimmed) return fail('invalid_name', 'name is required');
    const slug = normalizeSlug(trimmed);
    if (!slug || !APP_SLUG_RE.test(slug)) return fail('invalid_name', 'name must contain letters or digits');
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const taken = this.bySlug(asAppSlug(slug));
    if (!taken.ok) return fail('database_error', taken.errorMessage);
    if (taken.data.value) return fail('duplicate_slug', `an app with the slug "${slug}" already exists`);
    const order = this.nextOrder();
    if (!order.ok) return fail('database_error', order.errorMessage);
    const id = asAppId(randomUUID());
    const now = Date.now();
    const inserted = databaseUpdate('could not save the app', () =>
      this.deps.db.run(qb.insertInto('apps').values({
        id, name: trimmed, slug: asAppSlug(slug), sort_order: order.data.value,
        created_at: now, updated_at: now, created_by: actor.username, updated_by: actor.username,
      })));
    if (!inserted.ok) return fail('database_error', inserted.errorMessage);
    log.info(`app "${trimmed}" (${slug}) created`);
    return { ok: true, resultType: 'save_app', data: { id, name: trimmed, slug: asAppSlug(slug) } } satisfies SaveAppSuccess;
  }

  /** Rename an app. The slug is stable once created (v1 — plan §6); an
   *  absent name is a no-op that returns the row as it stands. */
  async renameApp(slug: AppSlug, name: string | undefined): Promise<SaveAppResult> {
    const fail = (errorCode: SaveAppErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'save_app', errorCode, errorMessage }) satisfies SaveAppFailure;
    const found = this.bySlug(slug);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('app_not_found', 'no such app');
    if (name === undefined) {
      return { ok: true, resultType: 'save_app', data: { id: row.id, name: row.name, slug } } satisfies SaveAppSuccess;
    }
    const trimmed = name.trim();
    if (!trimmed) return fail('invalid_name', 'name is required');
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const updated = databaseUpdate('could not save the app', () =>
      this.deps.db.run(qb.updateTable('apps')
        .set({ name: trimmed, updated_at: Date.now(), updated_by: actor.username })
        .where('id', '=', row.id)));
    if (!updated.ok) return fail('database_error', updated.errorMessage);
    return { ok: true, resultType: 'save_app', data: { id: row.id, name: trimmed, slug } } satisfies SaveAppSuccess;
  }

  /** Delete an app: the FK cascades its workspaces and their terminals,
   *  and un-tags its jobs (SET NULL); the deleted terminals' tmux
   *  sessions are killed best-effort afterwards — a kill can never fail
   *  the delete. */
  async deleteApp(slug: AppSlug): Promise<DeleteAppResult> {
    const fail = (errorCode: DeleteAppErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'delete_app', errorCode, errorMessage }) satisfies DeleteAppFailure;
    const found = this.bySlug(slug);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('app_not_found', 'no such app');
    // Collected before the cascade removes them: the ids name the tmux
    // sessions to kill (terminalSessionName derives them — never stored).
    const terminals = databaseRead('could not read terminals', () =>
      this.deps.db.all(qb.selectFrom('terminals').select(['terminals.id'])
        .innerJoin('workspaces', 'workspaces.id', 'terminals.workspace_id')
        .where('workspaces.app_id', '=', row.id)));
    if (!terminals.ok) return fail('database_error', terminals.errorMessage);
    const deleted = databaseUpdate('could not delete the app', () =>
      this.deps.db.run(qb.deleteFrom('apps').where('id', '=', row.id)));
    if (!deleted.ok) return fail('database_error', deleted.errorMessage);
    // These kills are best-effort and logged either way (plan §4): a
    // terminal whose spawn failed (dead tab) or whose workspace side is
    // down simply has no session to kill — the kill is then a no-op.
    for (const t of terminals.data.value) await this.deps.killSession(terminalSessionName(t.id));
    log.info(`app ${slug} deleted (${terminals.data.value.length} terminal sessions killed best-effort)`);
    return { ok: true, resultType: 'delete_app', data: { id: row.id } } satisfies DeleteAppSuccess;
  }

  /** All apps, ordered — the jobs dialog's tag picker (plan §9: the
   *  page reads this once server-side; no per-job fetches anywhere). */
  listApps(): ListAppsResult {
    const read = databaseRead('could not read apps', (): Array<{
      id: AppId; name: string; slug: AppSlug; sort_order: number;
    }> => this.deps.db.all(qb.selectFrom('apps').select(['id', 'name', 'slug', 'sort_order'])
      .orderBy('sort_order', 'asc').orderBy('name', 'asc')));
    if (!read.ok) {
      return {
        ok: false, resultType: 'list_apps', errorCode: 'database_error', errorMessage: read.errorMessage,
      } satisfies ListAppsFailure;
    }
    return {
      ok: true, resultType: 'list_apps',
      data: { apps: read.data.value.map(a => ({ id: a.id, name: a.name, slug: a.slug, order: a.sort_order })) },
    } satisfies ListAppsSuccess;
  }
}
