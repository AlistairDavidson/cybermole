// note_get: one note by id. Params arrive as strings; the schema's z.coerce
// makes the number.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';
import { rowToNote, storeOp, type Note, type NotesStore } from './notes-core.ts';

export type NoteGetData = { note: Note };
export type NoteGetErrorCode = 'note_not_found' | 'database_error';
export type NoteGetSuccess = ResultSuccess<'note_get', NoteGetData>;
export type NoteGetFailure = ResultFailure<'note_get', NoteGetData, NoteGetErrorCode>;
export type NoteGetResult = NoteGetSuccess | NoteGetFailure;

const fail = (errorCode: NoteGetErrorCode, errorMessage: string): NoteGetFailure => ({
  ok: false,
  resultType: 'note_get',
  errorCode,
  errorMessage,
});

/** Archived notes are hidden from the default list, never from a direct get. */
export function noteGetResult(store: NotesStore, id: number): NoteGetResult {
  const row = storeOp('could not read the note', () => store.findById(id));
  if (!row.ok) return fail('database_error', row.why);
  if (row.value === undefined)
    return fail('note_not_found', `no note #${id} — note_list shows what is there`);
  return { ok: true, resultType: 'note_get', data: { note: rowToNote(row.value) } } satisfies NoteGetSuccess;
}
