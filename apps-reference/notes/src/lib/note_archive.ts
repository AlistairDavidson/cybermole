// The note_archive action's logic — the archive half of the notes family,
// grown from the add_action stub. Archive is a FLAG, never a delete: the
// row keeps its title, body, tags and timestamps; the default list hides
// it and `archived=true` shows it again. Idempotent on purpose —
// archiving an archived note stays green (the app's one
// removal-adjacent action is deliberately the gentlest one). Runtime-
// kit-free (types only) and node-free — plain-node testable.
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

/** Archive one note — the only removal-adjacent action the app has, and
 *  it removes nothing: `archived` flips to true, everything else stands. */
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
