// note_create: capture one note. Type-only kit imports, so plain-node testable.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';
import { BODY_MAX, TITLE_MAX, rowToNote, storeOp, validateTags, type Note, type NotesStore } from './notes-core.ts';

export type NoteCreateData = { note: Note };
export type NoteCreateErrorCode = 'invalid_title' | 'invalid_body' | 'invalid_tags' | 'database_error';
export type NoteCreateSuccess = ResultSuccess<'note_create', NoteCreateData>;
export type NoteCreateFailure = ResultFailure<'note_create', NoteCreateData, NoteCreateErrorCode>;
export type NoteCreateResult = NoteCreateSuccess | NoteCreateFailure;

export interface NoteCreateInput {
  title?: string | undefined;
  body?: string | undefined;
  tags?: string[] | undefined;
}

const fail = (errorCode: NoteCreateErrorCode, errorMessage: string): NoteCreateFailure => ({
  ok: false,
  resultType: 'note_create',
  errorCode,
  errorMessage,
});

/** The schema judges shape; empty titles, bounds and tag rules are judged
 *  here, so every face answers the same codes. */
export function noteCreateResult(store: NotesStore, input: NoteCreateInput): NoteCreateResult {
  const title = (input.title ?? '').trim();
  if (title === '') return fail('invalid_title', 'title is required');
  if (title.length > TITLE_MAX)
    return fail('invalid_title', `title is too long (max ${TITLE_MAX} chars)`);
  const body = (input.body ?? '').trim();
  if (body.length > BODY_MAX)
    return fail('invalid_body', `body is too long (max ${BODY_MAX} chars)`);
  const tags = validateTags(input.tags ?? []);
  if (!tags.ok) return fail('invalid_tags', tags.why);
  const now = Date.now();
  const inserted = storeOp('could not save the note', () =>
    store.insert({ title, body, tags: tags.tags.join(','), archived: 0, created_at: now, updated_at: now }),
  );
  if (!inserted.ok) return fail('database_error', inserted.why);
  return {
    ok: true,
    resultType: 'note_create',
    data: { note: rowToNote(inserted.value) },
  } satisfies NoteCreateSuccess;
}
