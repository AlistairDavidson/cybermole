// routes.ts reaches the browser (islands import the table), so its handlers
// can't import the sqlite half; they read the store from this slot, which
// server-only modules bind (src/pages/api/[...path].ts).
import type { NotesStore } from './notes-core.ts';

let bound: NotesStore | null = null;

/** Idempotent. */
export function bindNotesStore(store: NotesStore): void {
  bound = store;
}

/** An unbound read is a wiring bug; the binder answers internal_error. */
export function notesStore(): NotesStore {
  if (bound === null) {
    throw new Error(
      'the notes store is not bound — server code must call bindNotesStore() first ' +
        '(src/pages/api/[...path].ts does, at module scope)',
    );
  }
  return bound;
}
