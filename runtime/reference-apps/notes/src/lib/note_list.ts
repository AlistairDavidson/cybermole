// The note_list action's logic — the find half of the notes family, grown
// from the add_action stub: compile the query (search + tag + archived)
// into the filter the store binds, shape the rows back. Runtime-kit-free
// (types only) and node-free — the tests import this with plain node.
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

/** List notes: live only by default (`archived=true` for the archive),
 *  substring search over title/body/tags, an exact tag filter. The page
 *  renders the same answer server-side — one vocabulary, every face. */
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
