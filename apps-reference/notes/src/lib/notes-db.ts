// notes-db.ts — the app's own data/app.db on the kit's node:sqlite
// helper (packages/app-kit/src/db/sqlite.ts — the console state db's
// shape: lazy connection, cached prepared statements, kysely as the
// compile-only query builder, a replaced file adopted at next use). One
// notes table; tags stored comma-joined (the core's format), archived a
// 0/1 flag — archive is a flag, never a delete, all the way down.
//
// The ONLY module that imports the kit at runtime besides the binder
// glue: everything above it (the actions) sees the NotesStore interface
// from notes-core.ts, so the domain stays plain-node testable; this half
// is exercised end-to-end through every face. The tree-root walk keeps
// data/ where the tree is, wherever the built entry runs from.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Generated, sql } from 'kysely';
import { createQb, SqliteDb } from '@cybermole/app-kit';
import { LIST_LIMIT, type ListFilter, type NoteRow, type NotesStore } from './notes-core';

/** The store's one table, for kysely's compile-only typing — the AUTO-
 * INCREMENT id is `Generated` (provided by sqlite on insert), everything
 * else mirrors NoteRow (archived the 0/1 flag sqlite stores). */
interface NotesSchema {
  notes: {
    id: Generated<number>;
    title: string;
    body: string;
    tags: string;
    archived: 0 | 1;
    created_at: number;
    updated_at: number;
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_archived_created ON notes (archived, created_at DESC, id DESC);
`;

/** The sqlite NotesStore. Methods throw on a sqlite error like
 *  node:sqlite itself — the actions wrap them in notes-core's storeOp
 *  (the db boundary), the kit's databaseRead/databaseUpdate pattern. */
export class SqlNotesStore implements NotesStore {
  private readonly db: SqliteDb;
  private readonly qb = createQb<NotesSchema>();

  constructor(readonly file: string) {
    this.db = new SqliteDb(file, { schema: SCHEMA, version: 1, label: 'notes db' });
  }

  insert(row: Omit<NoteRow, 'id'>): NoteRow {
    this.db.run(this.qb.insertInto('notes').values(row));
    // The sync connection's newest id — equivalent to last_insert_rowid()
    // here (ids only grow, and no other writer runs between the two), in
    // the house style (eb.fn.max, no raw SQL — src/lib/apps.ts's pattern).
    const id = this.db.get(
      this.qb.selectFrom('notes').select(eb => eb.fn.max<number>('id').as('id')),
    )!.id;
    return { ...row, id };
  }

  list(filter: ListFilter): NoteRow[] {
    let query = this.qb
      .selectFrom('notes')
      .selectAll()
      .where('archived', '=', filter.archived ? 1 : 0);
    if (filter.searchLike !== null) {
      const pattern = filter.searchLike;
      query = query.where(eb =>
        eb.or([
          eb('title', 'like', pattern),
          eb('body', 'like', pattern),
          eb('tags', 'like', pattern),
        ]),
      );
    }
    if (filter.tagLike !== null) {
      // The comma-padded join makes tag matching segment-exact: tag 'a'
      // matches tags 'a,b' but not 'ba'. ESCAPE '\' pairs with the core's
      // escapeLike (a literal backslash in SQL — sqlite does not
      // backslash-escape string literals).
      const pattern = filter.tagLike;
      query = query.where(sql<boolean>`(',' || tags || ',') LIKE ${pattern} ESCAPE '\\'`);
    }
    return this.db.all(query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(LIST_LIMIT));
  }

  findById(id: number): NoteRow | undefined {
    return this.db.get(this.qb.selectFrom('notes').selectAll().where('id', '=', id));
  }

  update(
    id: number,
    patch: Partial<Pick<NoteRow, 'title' | 'body' | 'tags' | 'archived'>>,
    updatedAt: number,
  ): NoteRow | undefined {
    const changed = this.db.run(
      this.qb.updateTable('notes').set({ ...patch, updated_at: updatedAt }).where('id', '=', id),
    );
    if (Number(changed.changes) === 0) return undefined;
    return this.findById(id);
  }
}

let store: SqlNotesStore | null = null;

/** The process's store (memoized — one connection, lazily opened). */
export function getAppDb(): SqlNotesStore {
  if (store === null) store = new SqlNotesStore(dataFile());
  return store;
}

/** data/app.db under the tree root, found by walking up from THIS FILE to
 *  app.json (the manifest every tree has) — the same answer at build time
 *  (src/…) and at serve time (the built entry under dist/server/chunks/),
 *  with no baked path to go stale. SqliteDb opens lazily, so merely
 *  importing this module never touches the disk. */
function dataFile(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'app.json'))) return path.join(dir, 'data', 'app.db');
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(`no app.json above ${import.meta.url} — not running inside the app tree`);
    dir = parent;
  }
}
