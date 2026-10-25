// notes-core.ts — the pure core every note action is assembled from:
// the shapes, the validation families' shared rules, tag handling and
// the list-filter compilation (LIKE patterns, escaped). Node-free AND
// runtime-kit-free (the family TYPES are `import type` — stripped before
// execution) so the unit tests import this file, and the action modules
// that depend on it, with plain node (src/lib/ping.ts's rule).
//
// The sqlite half lives in notes-db.ts behind the NotesStore interface
// declared here: the actions take the STORE as a parameter, so their
// logic is testable against an in-memory fake (tests/*.test.mjs) while
// the real store is exercised end-to-end through every face — one action
// vocabulary, every face (apps-plan §0).
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

// ---------- shapes ----------

/** One note as every face answers it — note_get/note_create/note_edit/
 *  note_archive's `data.note`, one row of note_list's `data.notes`. */
export interface Note {
  id: number;
  title: string;
  body: string;
  tags: string[];
  archived: boolean;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  updatedAt: number;
}

/** One storage row — the sqlite side's own shape (tags one comma-joined
 *  string, archived 0/1); rowToNote is the boundary. */
export interface NoteRow {
  id: number;
  title: string;
  body: string;
  tags: string;
  archived: 0 | 1;
  created_at: number;
  updated_at: number;
}

/** A compiled list filter: the store binds these patterns to SQL, and
 *  compiling them HERE keeps the escaping rules unit-tested. */
export interface ListFilter {
  archived: boolean;
  /** `%q%` over title/body/tags, wildcards escaped — null = no search */
  searchLike: string | null;
  /** `%,tag,%` against `',' || tags || ','` — null = no tag filter */
  tagLike: string | null;
}

/** The queries the actions need — notes-db.ts implements this over
 *  data/app.db (the kit's node:sqlite helper); tests fake it in memory. */
export interface NotesStore {
  /** Write one note; assigns and answers its id. */
  insert(row: Omit<NoteRow, 'id'>): NoteRow;
  /** The filter's matching rows, newest first. */
  list(filter: ListFilter): NoteRow[];
  findById(id: number): NoteRow | undefined;
  /** Merge `patch` into the row and stamp `updatedAt`; undefined when no
   *  such row. */
  update(
    id: number,
    patch: Partial<Pick<NoteRow, 'title' | 'body' | 'tags' | 'archived'>>,
    updatedAt: number,
  ): NoteRow | undefined;
}

// ---------- limits (one place, the validation messages quote them) ----------

export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;
export const TAG_MAX = 40;
export const TAGS_MAX = 10;
/** Newest-first page cap — an honest v1 limit, named in note_list's data. */
export const LIST_LIMIT = 200;

// ---------- tags ----------

/** Validate a raw tag list: each tag trims, lowercases and dedupes to
 *  1..TAG_MAX chars with no comma (a comma would corrupt the joined
 *  storage format and the tag filter's segment matching). */
export function validateTags(
  raw: string[],
): { ok: true; tags: string[] } | { ok: false; why: string } {
  if (raw.length > TAGS_MAX) return { ok: false, why: `too many tags (max ${TAGS_MAX})` };
  const seen = new Set<string>();
  for (const element of raw) {
    const tag = element.trim().toLowerCase();
    if (tag === '') return { ok: false, why: 'a tag is empty after trimming' };
    if (tag.length > TAG_MAX)
      return { ok: false, why: `a tag is too long (max ${TAG_MAX} chars): ${JSON.stringify(tag)}` };
    if (tag.includes(','))
      return { ok: false, why: `a tag may not contain a comma: ${JSON.stringify(tag)}` };
    seen.add(tag);
  }
  return { ok: true, tags: [...seen].sort() };
}

// ---------- search ----------

/** Escape a LIKE fragment's wildcards (% _ \) — the SQL side matches with
 *  ESCAPE '\'. */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** Compile a note_list query into the filter the store binds: trimmed
 *  inputs, absent search/tag = null patterns, `archived` strictly
 *  'true'/'false' (default false — the live list). */
export function compileListFilter(query: {
  search?: string | undefined;
  tag?: string | undefined;
  archived?: string | undefined;
}): { ok: true; filter: ListFilter } | { ok: false; why: string } {
  const archived = query.archived ?? 'false';
  if (archived !== 'true' && archived !== 'false')
    return {
      ok: false,
      why: `archived must be "true" or "false" (got ${JSON.stringify(archived)})`,
    };
  const search = (query.search ?? '').trim();
  const tag = (query.tag ?? '').trim().toLowerCase();
  return {
    ok: true,
    filter: {
      archived: archived === 'true',
      searchLike: search === '' ? null : `%${escapeLike(search)}%`,
      tagLike: tag === '' ? null : `%,${escapeLike(tag)},%`,
    },
  };
}

// ---------- shaping ----------

/** The storage row → the wire shape (the two halves of every family). */
export function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    tags: row.tags === '' ? [] : row.tags.split(','),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- the db boundary at the store seam ----------

/** Run one store operation at the db boundary — the kit's databaseRead/
 *  databaseUpdate pattern (src/lib/db.ts's seam), written LOCAL so this
 *  module and the action modules importing it stay runtime-kit-free and
 *  plain-node testable. A thrown sqlite error (lock timeout, unwritable
 *  file) becomes the action's `database_error` failure instead of a
 *  handler throw the binder would have to answer as internal_error. */
export function storeOp<T>(
  context: string,
  op: () => T,
): { ok: true; value: T } | { ok: false; why: string } {
  try {
    return { ok: true, value: op() };
  } catch (err) {
    return { ok: false, why: `${context}: ${(err as Error).message}` };
  }
}
