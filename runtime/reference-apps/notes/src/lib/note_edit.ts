// note_edit: merge any of title/body/tags into a note; unprovided fields stand.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';
import { BODY_MAX, TITLE_MAX, rowToNote, storeOp, validateTags, type Note, type NotesStore } from './notes-core.ts';

export type NoteEditData = { note: Note };
export type NoteEditErrorCode =
  | 'note_not_found'
  | 'invalid_title'
  | 'invalid_body'
  | 'invalid_tags'
  | 'invalid_patch'
  | 'database_error';
export type NoteEditSuccess = ResultSuccess<'note_edit', NoteEditData>;
export type NoteEditFailure = ResultFailure<'note_edit', NoteEditData, NoteEditErrorCode>;
export type NoteEditResult = NoteEditSuccess | NoteEditFailure;

export interface NoteEditPatch {
  title?: string | undefined;
  body?: string | undefined;
  tags?: string[] | undefined;
}

const fail = (errorCode: NoteEditErrorCode, errorMessage: string): NoteEditFailure => ({
  ok: false,
  resultType: 'note_edit',
  errorCode,
  errorMessage,
});

/** The title can't be blanked (clear the body with "" instead), and an
 *  empty patch is refused rather than silently doing nothing. */
export function noteEditResult(store: NotesStore, id: number, patch: NoteEditPatch): NoteEditResult {
  const current = storeOp('could not read the note', () => store.findById(id));
  if (!current.ok) return fail('database_error', current.why);
  if (current.value === undefined)
    return fail('note_not_found', `no note #${id} — note_list shows what is there`);

  const next: { title?: string; body?: string; tags?: string } = {};
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title === '') return fail('invalid_title', 'title is required (an edit may not blank it)');
    if (title.length > TITLE_MAX)
      return fail('invalid_title', `title is too long (max ${TITLE_MAX} chars)`);
    next.title = title;
  }
  if (patch.body !== undefined) {
    const body = patch.body.trim();
    if (body.length > BODY_MAX)
      return fail('invalid_body', `body is too long (max ${BODY_MAX} chars)`);
    next.body = body;
  }
  if (patch.tags !== undefined) {
    const tags = validateTags(patch.tags);
    if (!tags.ok) return fail('invalid_tags', tags.why);
    next.tags = tags.tags.join(',');
  }
  if (Object.keys(next).length === 0)
    return fail('invalid_patch', 'nothing to edit — provide title, body or tags');

  const updated = storeOp('could not save the note', () => store.update(id, next, Date.now()));
  if (!updated.ok) return fail('database_error', updated.why);
  if (updated.value === undefined)
    return fail('note_not_found', `no note #${id} — it went away while saving`);
  return { ok: true, resultType: 'note_edit', data: { note: rowToNote(updated.value) } } satisfies NoteEditSuccess;
}
