// The pure core every note action is built from: shapes, validation rules,
// tags and list-filter compilation. Type-only kit imports, so the tests run
// it with plain node. Actions take a NotesStore parameter, so they test
// against an in-memory fake; the sqlite store (notes-db.ts) is covered end
// to end.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

// ---------- shapes ----------

/** The wire shape every action answers with. */
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

/** The storage row (tags comma-joined, archived 0/1); rowToNote converts. */
export interface NoteRow {
  id: number;
  title: string;
  body: string;
  tags: string;
  archived: 0 | 1;
  created_at: number;
  updated_at: number;
}

/** Compiled here so the escaping rules are unit-tested. */
export interface ListFilter {
  archived: boolean;
  /** `%q%` over title/body/tags, wildcards escaped; null = no search */
  searchLike: string | null;
  /** `%,tag,%` against `',' || tags || ','`; null = no tag filter */
  tagLike: string | null;
}

export interface NotesStore {
  /** Assigns and returns the id. */
  insert(row: Omit<NoteRow, 'id'>): NoteRow;
  /** Newest first. */
  list(filter: ListFilter): NoteRow[];
  findById(id: number): NoteRow | undefined;
  /** Merges `patch` and stamps `updatedAt`; undefined when there's no such row. */
  update(
    id: number,
    patch: Partial<Pick<NoteRow, 'title' | 'body' | 'tags' | 'archived'>>,
    updatedAt: number,
  ): NoteRow | undefined;
}

// ---------- limits (quoted by the validation messages) ----------

export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;
export const TAG_MAX = 40;
export const TAGS_MAX = 10;
/** Newest-first page cap. */
export const LIST_LIMIT = 200;

// ---------- tags ----------

/** Trim, lowercase and dedupe to 1..TAG_MAX chars. No commas: they would
 *  break the joined storage format and the tag filter. */
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

/** The SQL side matches with ESCAPE '\'. */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** Absent search/tag become null patterns; `archived` must be exactly
 *  'true' or 'false' (default false). */
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

/** The list's excerpt rule, shared by the SSR loop and the list enhancer —
 *  one definition so the two mirrors can't disagree on the cap. */
export function noteExcerpt(body: string): string {
  return body.length > 160 ? `${body.slice(0, 160)}…` : body;
}

// ---------- db boundary ----------

/** The kit's databaseRead/Update pattern, written locally so action modules
 *  stay kit-free. A sqlite error becomes the action's `database_error`
 *  rather than a throw the binder would answer as internal_error. */
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
