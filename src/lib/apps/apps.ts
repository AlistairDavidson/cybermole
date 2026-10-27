// Apps: named, ordered groups of workspaces with a stable slug. Deleting one
// cascades through workspaces and terminals via FKs, then kills their tmux
// sessions best-effort. Jobs are only tagged (SET NULL), never owned.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { qb, type StateDb } from '../platform/db';
import { componentLogger } from '../platform/logger';
import { emitDomainEvent } from '../platform/events';
import { terminalSessionName } from '../terminals/tmux';
import { checkedCwd } from '../terminals/workspaces';
import { orderPlan } from '../order-plan';
import {
  asAppId,
  asAppSlug,
  APP_SLUG_RE,
  databaseRead,
  databaseUpdate,
  normalizeSlug,
  type AppId,
  type AppSlug,
  type DatabaseReadResult,
  type ResultFailure,
  type ResultSuccess,
  type TmuxSessionName,
} from '@cybermole/app-kit';
import type { AppState } from '../platform/types';

const log = componentLogger('apps');

// ---------- results ----------

export type SaveAppData = { id: AppId; name: string; slug: AppSlug; cwd: string | null };
/** invalid_name: empty, or slugs to nothing. duplicate_slug is pre-checked;
 *  the check-then-insert race degrades to database_error. */
export type SaveAppErrorCode =
  'invalid_name' | 'invalid_cwd' | 'duplicate_slug' | 'app_not_found' | 'database_error';
export type SaveAppSuccess = ResultSuccess<'save_app', SaveAppData>;
export type SaveAppFailure = ResultFailure<'save_app', SaveAppData, SaveAppErrorCode>;
export type SaveAppResult = SaveAppSuccess | SaveAppFailure;

export type DeleteAppData = { id: AppId };
export type DeleteAppErrorCode = 'app_not_found' | 'database_error';
export type DeleteAppSuccess = ResultSuccess<'delete_app', DeleteAppData>;
export type DeleteAppFailure = ResultFailure<'delete_app', DeleteAppData, DeleteAppErrorCode>;
export type DeleteAppResult = DeleteAppSuccess | DeleteAppFailure;

/** One read serves both the jobs tag picker and GET /api/state. */
export type ListAppsData = { apps: AppState[] };
export type ListAppsErrorCode = 'database_error';
export type ListAppsSuccess = ResultSuccess<'list_apps', ListAppsData>;
export type ListAppsFailure = ResultFailure<'list_apps', ListAppsData, ListAppsErrorCode>;
export type ListAppsResult = ListAppsSuccess | ListAppsFailure;

/** A full-list reorder: the ids are every app row, each once, in their
 *  new order. invalid_order means the list doesn't match the rows (a
 *  stale client re-reads state and retries). */
export type ReorderAppsData = { order: AppId[] };
export type ReorderAppsErrorCode = 'invalid_order' | 'database_error';
export type ReorderAppsSuccess = ResultSuccess<'reorder_apps', ReorderAppsData>;
export type ReorderAppsFailure = ResultFailure<
  'reorder_apps',
  ReorderAppsData,
  ReorderAppsErrorCode
>;
export type ReorderAppsResult = ReorderAppsSuccess | ReorderAppsFailure;

// ---------- domain ----------

export interface AppsDeps {
  db: StateDb;
  /** For created_by/updated_by. */
  username: () => DatabaseReadResult<string | null>;
  killSession: (name: TmuxSessionName) => Promise<boolean>;
}

export class Apps {
  constructor(private deps: AppsDeps) {}

  /** 'unknown' if the credential is somehow missing (login requires it). */
  private actor(): { ok: true; username: string } | { ok: false; errorMessage: string } {
    const who = this.deps.username();
    return who.ok
      ? { ok: true, username: who.data.value ?? 'unknown' }
      : { ok: false, errorMessage: who.errorMessage ?? 'could not read the credential' };
  }

  /** Steps of 10. */
  private nextOrder() {
    return databaseRead(
      'could not read app order',
      () =>
        (this.deps.db.get(
          qb.selectFrom('apps').select(eb => eb.fn.max<number | null>('sort_order').as('max')),
        )?.max ?? 0) + 10,
    );
  }

  private bySlug(slug: AppSlug) {
    return databaseRead(
      'could not read app',
      () =>
        this.deps.db.get(
          qb.selectFrom('apps').select(['id', 'name', 'cwd']).where('slug', '=', slug),
        ) ?? null,
    );
  }

  /** The slug is derived from the name. An empty cwd means unset (the
   *  server default); a missing one is created, once the rest validates. */
  async saveApp(name: string, cwd?: string): Promise<SaveAppResult> {
    const fail = (errorCode: SaveAppErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'save_app', errorCode, errorMessage }) satisfies SaveAppFailure;
    const trimmed = name.trim();
    if (!trimmed) return fail('invalid_name', 'name is required');
    const slug = normalizeSlug(trimmed);
    if (!slug || !APP_SLUG_RE.test(slug))
      return fail('invalid_name', 'name must contain letters or digits');
    const wanted = cwd === undefined ? '' : cwd.trim();
    let dir: string | null = null;
    if (wanted !== '') {
      if (!wanted.startsWith('/'))
        return fail('invalid_cwd', `cwd must be an absolute path: ${wanted}`);
      if (fs.existsSync(wanted)) {
        const checked = checkedCwd(wanted);
        if (!checked.ok) return fail('invalid_cwd', checked.reason);
      }
      dir = wanted;
    }
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const taken = this.bySlug(asAppSlug(slug));
    if (!taken.ok) return fail('database_error', taken.errorMessage);
    if (taken.data.value)
      return fail('duplicate_slug', `an app with the slug "${slug}" already exists`);
    const order = this.nextOrder();
    if (!order.ok) return fail('database_error', order.errorMessage);
    if (dir !== null) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return fail('invalid_cwd', `could not create ${dir}: ${(err as Error).message}`);
      }
    }
    const id = asAppId(randomUUID());
    const now = Date.now();
    const inserted = databaseUpdate('could not save the app', () =>
      this.deps.db.run(
        qb.insertInto('apps').values({
          id,
          name: trimmed,
          slug: asAppSlug(slug),
          cwd: dir,
          sort_order: order.data.value,
          created_at: now,
          updated_at: now,
          created_by: actor.username,
          updated_by: actor.username,
        }),
      ),
    );
    if (!inserted.ok) return fail('database_error', inserted.errorMessage);
    log.info(`app "${trimmed}" (${slug}) created${dir === null ? '' : `, cwd ${dir}`}`);
    emitDomainEvent({ topic: 'apps', type: 'app_created', slug: asAppSlug(slug) });
    return {
      ok: true,
      resultType: 'save_app',
      data: { id, name: trimmed, slug: asAppSlug(slug), cwd: dir },
    } satisfies SaveAppSuccess;
  }

  /** Absent fields keep; the slug never changes. cwd null clears it. */
  async renameApp(
    slug: AppSlug,
    name: string | undefined,
    cwd: string | null | undefined,
  ): Promise<SaveAppResult> {
    const fail = (errorCode: SaveAppErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'save_app', errorCode, errorMessage }) satisfies SaveAppFailure;
    const found = this.bySlug(slug);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('app_not_found', 'no such app');
    if (name === undefined && cwd === undefined) {
      return {
        ok: true,
        resultType: 'save_app',
        data: { id: row.id, name: row.name, slug, cwd: row.cwd },
      } satisfies SaveAppSuccess;
    }
    const trimmed = name === undefined ? undefined : name.trim();
    if (trimmed === '') return fail('invalid_name', 'name is required');
    let dir: string | null | undefined;
    if (cwd === null)
      dir = null; // an empty string is a 400, not a clear
    else if (cwd !== undefined) {
      const checked = checkedCwd(cwd.trim());
      if (!checked.ok) return fail('invalid_cwd', checked.reason);
      dir = checked.cwd;
    }
    const actor = this.actor();
    if (!actor.ok) return fail('database_error', actor.errorMessage);
    const updated = databaseUpdate('could not save the app', () =>
      this.deps.db.run(
        qb
          .updateTable('apps')
          .set({
            ...(trimmed === undefined ? {} : { name: trimmed }),
            ...(dir === undefined ? {} : { cwd: dir }),
            updated_at: Date.now(),
            updated_by: actor.username,
          })
          .where('id', '=', row.id),
      ),
    );
    if (!updated.ok) return fail('database_error', updated.errorMessage);
    emitDomainEvent({ topic: 'apps', type: 'app_updated', slug });
    return {
      ok: true,
      resultType: 'save_app',
      data: { id: row.id, name: trimmed ?? row.name, slug, cwd: dir === undefined ? row.cwd : dir },
    } satisfies SaveAppSuccess;
  }

  /** Tmux kills come after the cascade and never fail the delete. */
  async deleteApp(slug: AppSlug): Promise<DeleteAppResult> {
    const fail = (errorCode: DeleteAppErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'delete_app', errorCode, errorMessage }) satisfies DeleteAppFailure;
    const found = this.bySlug(slug);
    if (!found.ok) return fail('database_error', found.errorMessage);
    const row = found.data.value;
    if (!row) return fail('app_not_found', 'no such app');
    // Read before the cascade removes them; the ids name the sessions.
    const terminals = databaseRead('could not read terminals', () =>
      this.deps.db.all(
        qb
          .selectFrom('terminals')
          .select(['terminals.id'])
          .innerJoin('workspaces', 'workspaces.id', 'terminals.workspace_id')
          .where('workspaces.app_id', '=', row.id),
      ),
    );
    if (!terminals.ok) return fail('database_error', terminals.errorMessage);
    const deleted = databaseUpdate('could not delete the app', () =>
      this.deps.db.run(qb.deleteFrom('apps').where('id', '=', row.id)),
    );
    if (!deleted.ok) return fail('database_error', deleted.errorMessage);
    for (const t of terminals.data.value) await this.deps.killSession(terminalSessionName(t.id));
    log.info(
      `app ${slug} deleted (${terminals.data.value.length} terminal sessions killed best-effort)`,
    );
    emitDomainEvent({ topic: 'apps', type: 'app_deleted', slug });
    return { ok: true, resultType: 'delete_app', data: { id: row.id } } satisfies DeleteAppSuccess;
  }

  /** sort_order, then created_at as a tiebreak. */
  listApps(): ListAppsResult {
    const read = databaseRead(
      'could not read apps',
      (): Array<{
        id: AppId;
        name: string;
        slug: AppSlug;
        cwd: string | null;
        sort_order: number;
        created_at: number;
      }> =>
        this.deps.db.all(
          qb
            .selectFrom('apps')
            .select(['id', 'name', 'slug', 'cwd', 'sort_order', 'created_at'])
            .orderBy('sort_order', 'asc')
            .orderBy('created_at', 'asc'),
        ),
    );
    if (!read.ok) {
      return {
        ok: false,
        resultType: 'list_apps',
        errorCode: 'database_error',
        errorMessage: read.errorMessage,
      } satisfies ListAppsFailure;
    }
    return {
      ok: true,
      resultType: 'list_apps',
      data: {
        apps: read.data.value.map(a => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          cwd: a.cwd,
          order: a.sort_order,
        })),
      },
    } satisfies ListAppsSuccess;
  }

  /** Persists a full-list reorder: positions become steps of 10. The plan
   *  (same set, each once) is computed by order-plan's pure helper. */
  async reorderApps(ordered: AppId[]): Promise<ReorderAppsResult> {
    const fail = (errorCode: ReorderAppsErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'reorder_apps',
        errorCode,
        errorMessage,
      }) satisfies ReorderAppsFailure;
    if (ordered.length === 0) return fail('invalid_order', 'the order is empty');
    const rows = databaseRead('could not read apps', () =>
      this.deps.db.all(qb.selectFrom('apps').select(['id', 'sort_order'])),
    );
    if (!rows.ok) return fail('database_error', rows.errorMessage);
    const plan = orderPlan(
      rows.data.value.map(a => ({ id: a.id, sortOrder: a.sort_order })),
      ordered,
      'app',
      'in this list',
    );
    if (!plan.ok) return fail('invalid_order', plan.message);
    if (plan.updates.length > 0) {
      const actor = this.actor();
      if (!actor.ok) return fail('database_error', actor.errorMessage);
      const now = Date.now();
      for (const update of plan.updates) {
        const updated = databaseUpdate('could not save the app order', () =>
          this.deps.db.run(
            qb
              .updateTable('apps')
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
      log.info(`${plan.updates.length} app(s) reordered`);
    }
    return {
      ok: true,
      resultType: 'reorder_apps',
      data: { order: ordered },
    } satisfies ReorderAppsSuccess;
  }
}
