// note_archive: a flag, never a delete. The default list hides archived
// notes; `archived=true` shows them. Idempotent.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';
import { rowToNote, storeOp, type Note, type NotesStore } from './notes-core.ts';

export type NoteArchiveData = { note: Note };
export type NoteArchiveErrorCode = 'note_not_found' | 'database_error';
export type NoteArchiveSuccess = ResultSuccess<'note_archive', NoteArchiveData>;
export type NoteArchiveFailure = ResultFailure<'note_archive', NoteArchiveData, NoteArchiveErrorCode>;
export type NoteArchiveResult = NoteArchiveSuccess | NoteArchiveFailure;

const fail = (errorCode: NoteArchiveErrorCode, errorMessage: string): NoteArchiveFailure => ({
  ok: false,
  resultType: 'note_archive',
  errorCode,
  errorMessage,
});

export function noteArchiveResult(store: NotesStore, id: number): NoteArchiveResult {
  const current = storeOp('could not read the note', () => store.findById(id));
  if (!current.ok) return fail('database_error', current.why);
  if (current.value === undefined)
    return fail('note_not_found', `no note #${id} — note_list shows what is there`);
  const updated = storeOp('could not archive the note', () => store.update(id, { archived: 1 }, Date.now()));
  if (!updated.ok) return fail('database_error', updated.why);
  if (updated.value === undefined)
    return fail('note_not_found', `no note #${id} — it went away while archiving`);
  return { ok: true, resultType: 'note_archive', data: { note: rowToNote(updated.value) } } satisfies NoteArchiveSuccess;
}
