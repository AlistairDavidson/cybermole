// hidden-sessions.ts — hide-from-list state for past pi sessions.
// pi's session store is append-only history, so 'delete' in the UI means
// 'hide from the sidebar': hidden-ness persists as a row in the state db's
// `sessions` overlay table (hidden_at set = hidden; src/lib/db.ts) and can
// be unhidden again — unhide just NULLs the flag, since the row may later
// carry other per-session metadata. pi's session files themselves are
// never touched. Reads and writes answer Results (database_read /
// database_update) so the API can 500 instead of lying. Ids arrive branded
// (validated at the request boundary by PiSessionIdSchema).
import { databaseRead, databaseUpdate, qb, type StateDb } from './db';
import type { PiSessionId } from '../types/branded';

const SAVE_FAILED = 'could not save hidden state';

export class HiddenSessions {
  constructor(private state: StateDb) {}

  /** Every hidden session id — including ones beyond the sidebar's
   *  newest-sessions cap, so its size is the full hidden count. Ids come
   *  from our own db, validated on write (trusted). */
  hiddenIds() {
    return databaseRead('could not read hidden state', () => new Set(
      this.state.all(qb.selectFrom('sessions').select('session_id').where('hidden_at', 'is not', null))
        .map(r => r.session_id)));
  }
  hide(id: PiSessionId) {
    return databaseUpdate(SAVE_FAILED, () =>
      this.state.run(qb.insertInto('sessions').values({ session_id: id, hidden_at: Date.now() })
        .onConflict(oc => oc.column('session_id').doUpdateSet(eb => ({ hidden_at: eb.ref('excluded.hidden_at') })))));
  }
  unhide(id: PiSessionId) {
    return databaseUpdate(SAVE_FAILED, () =>
      this.state.run(qb.updateTable('sessions').set({ hidden_at: null }).where('session_id', '=', id)));
  }
  unhideAll() {
    return databaseUpdate(SAVE_FAILED, () =>
      this.state.run(qb.updateTable('sessions').set({ hidden_at: null })));
  }
}
