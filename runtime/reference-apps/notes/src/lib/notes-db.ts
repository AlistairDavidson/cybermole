// The app's data/app.db on the kit's sqlite helper. One notes table; tags
// comma-joined, archived a 0/1 flag (archive never deletes). The only
// module besides the binder glue that imports the kit at runtime, so the
// actions stay plain-node testable.
import * as path from 'node:path';
import { type Generated, sql } from 'kysely';
import { appDataDir, createQb, SqliteDb } from '@cybermole/app-kit';
import { LIST_LIMIT, type ListFilter, type NoteRow, type NotesStore } from './notes-core';

/** For kysely's typing: the AUTOINCREMENT id is `Generated`. */
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

/** Methods throw on sqlite errors; the actions wrap them in storeOp. */
export class SqlNotesStore implements NotesStore {
  private readonly db: SqliteDb;
  private readonly qb = createQb<NotesSchema>();

  constructor(readonly file: string) {
    this.db = new SqliteDb(file, { schema: SCHEMA, version: 1, label: 'notes db' });
  }

  insert(row: Omit<NoteRow, 'id'>): NoteRow {
    this.db.run(this.qb.insertInto('notes').values(row));
    // The newest id equals last_insert_rowid() here: ids only grow, and
    // no other writer runs in between.
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
      // The comma-padded join makes tag matching segment-exact ('a'
      // matches 'a,b' but not 'ba'). sqlite doesn't backslash-escape
      // string literals, so ESCAPE '\' is a literal backslash.
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

/** Memoized: one connection, opened lazily. */
export function getAppDb(): SqlNotesStore {
  if (store === null) store = new SqlNotesStore(dataFile());
  return store;
}

/** Found by walking up from this file to app.json, which works from src/
 *  and from the built chunks alike (the kit's appDataDir); the e2e harness
 *  redirects it through CYBERMOLE_APP_DATA_DIR. Opening is lazy, so
 *  importing never touches the disk. */
function dataFile(): string {
  return path.join(appDataDir(import.meta.url), 'app.db');
}
