// note_list: compile search + tag + archived into the store's filter.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';
import { LIST_LIMIT, compileListFilter, rowToNote, storeOp, type Note, type NotesStore } from './notes-core.ts';

export type NoteListData = { notes: Note[]; count: number; limit: number };
export type NoteListErrorCode = 'invalid_archived' | 'database_error';
export type NoteListSuccess = ResultSuccess<'note_list', NoteListData>;
export type NoteListFailure = ResultFailure<'note_list', NoteListData, NoteListErrorCode>;
export type NoteListResult = NoteListSuccess | NoteListFailure;

export interface NoteListQuery {
  search?: string | undefined;
  tag?: string | undefined;
  archived?: string | undefined;
}

const fail = (errorCode: NoteListErrorCode, errorMessage: string): NoteListFailure => ({
  ok: false,
  resultType: 'note_list',
  errorCode,
  errorMessage,
});

/** Live notes by default; substring search over title/body/tags, exact tag match. */
export function noteListResult(store: NotesStore, query: NoteListQuery): NoteListResult {
  const compiled = compileListFilter(query);
  if (!compiled.ok) return fail('invalid_archived', compiled.why);
  const rows = storeOp('could not list notes', () => store.list(compiled.filter));
  if (!rows.ok) return fail('database_error', rows.why);
  const notes = rows.value.map(rowToNote);
  return {
    ok: true,
    resultType: 'note_list',
    data: { notes, count: notes.length, limit: LIST_LIMIT },
  } satisfies NoteListSuccess;
}
