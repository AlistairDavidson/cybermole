// app-store.ts — the server-side store binding, one indirection on
// purpose: routes.ts's module graph reaches the BROWSER (the islands
// import the table for the kit's typed client), so the table's handlers
// may not import the sqlite half — they read the store through this slot
// instead. The binding happens at module scope of server-only modules
// (src/pages/api/[...path].ts binds once for the API; the SSR pages call
// the store directly). Node-free like everything else in the table's
// graph.
import type { NotesStore } from './notes-core.ts';

let bound: NotesStore | null = null;

/** Bind the store the actions run against (idempotent — every server-only
 *  entry may call it). */
export function bindNotesStore(store: NotesStore): void {
  bound = store;
}

/** The bound store. An unbound read is a wiring bug, not a domain answer
 *  — the throw lands in the kit's binder and answers internal_error. */
export function notesStore(): NotesStore {
  if (bound === null) {
    throw new Error(
      'the notes store is not bound — server code must call bindNotesStore() first ' +
        '(src/pages/api/[...path].ts does, at module scope)',
    );
  }
  return bound;
}
