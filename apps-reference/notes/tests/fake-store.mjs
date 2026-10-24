// fake-store.mjs — the in-memory NotesStore the action tests run against
// (the interface lives in src/lib/notes-core.ts; the sqlite half,
// src/lib/notes-db.ts, is exercised end-to-end through every face).
// `captured` records every call so tests can assert the filter/patch the
// actions actually handed the store — the list fake answers the
// archived filter but deliberately does NOT re-implement search/tag (the
// patterns are what the actions compile; the SQL binding is the e2e's
// story, not the unit's).
export function fakeStore(seeded = []) {
  const rows = new Map(seeded.map(r => [r.id, { ...r }]));
  let nextId = seeded.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  const captured = [];
  return {
    rows,
    captured,
    insert(row) {
      captured.push(['insert', row]);
      const full = { ...row, id: nextId++ };
      rows.set(full.id, full);
      return { ...full };
    },
    list(filter) {
      captured.push(['list', filter]);
      return [...rows.values()]
        .filter(r => r.archived === (filter.archived ? 1 : 0))
        .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    },
    findById(id) {
      captured.push(['findById', id]);
      const row = rows.get(id);
      return row === undefined ? undefined : { ...row };
    },
    update(id, patch, updatedAt) {
      captured.push(['update', id, patch, updatedAt]);
      const row = rows.get(id);
      if (row === undefined) return undefined;
      Object.assign(row, patch, { updated_at: updatedAt });
      return { ...row };
    },
  };
}

/** A storage row for seeding, with the defaults a fresh note carries. */
export function row(over = {}) {
  return {
    id: 1,
    title: 'standup',
    body: 'did the thing',
    tags: 'standup',
    archived: 0,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over,
  };
}

/** A store whose every operation throws — the database_error face. */
export function throwingStore(message = 'sqlite: disk full') {
  const boom = () => {
    throw new Error(message);
  };
  return { insert: boom, list: boom, findById: boom, update: boom };
}
