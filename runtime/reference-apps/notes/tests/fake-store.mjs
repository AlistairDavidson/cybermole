// In-memory NotesStore for the action tests. `captured` records each call so
// tests can assert what the actions handed the store. The list fake applies
// the archived filter but not search/tag: the SQL binding is e2e territory.
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

/** A row with a fresh note's defaults. */
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

/** Every operation throws: the database_error path. */
export function throwingStore(message = 'sqlite: disk full') {
  const boom = () => {
    throw new Error(message);
  };
  return { insert: boom, list: boom, findById: boom, update: boom };
}
