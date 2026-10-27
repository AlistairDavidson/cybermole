// The shared full-list reorder plan behind terminal tabs, sidebar workspace
// rows and app groups: positions become steps of 10 (the append pattern),
// and rows whose stored value already matches keep it — a no-op reorder
// writes nothing. Node-free, so the client bundle can ship it and the unit
// tests can hit it directly.
export type OrderPlan<T> =
  | { ok: true; updates: { id: T; sortOrder: number }[] }
  | { ok: false; error: 'duplicate' | 'unknown' | 'missing'; message: string };

/** A new array with items[from] moved to items[to]; out-of-range or a
 *  no-op returns a copy unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = [...items];
  if (from < 0 || from >= copy.length || to < 0 || to >= copy.length || from === to) return copy;
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved!);
  return copy;
}

/** True when both lists hold the same items in the same order. */
export function sameSequence<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The persisted plan for a full-list reorder: `ordered` must be exactly
 *  `current`'s ids, each once. noun names the rows in error messages
 *  (the article is derived); context says where the ids must belong
 *  ('in this workspace', 'in this group', 'in this list'). */
export function orderPlan<T>(
  current: readonly { id: T; sortOrder: number }[],
  ordered: readonly T[],
  noun: string,
  context: string,
): OrderPlan<T> {
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a';
  if (new Set(ordered).size !== ordered.length)
    return { ok: false, error: 'duplicate', message: `the order lists ${article} ${noun} twice` };
  const have = new Set(current.map(r => r.id));
  for (const id of ordered)
    if (!have.has(id))
      return { ok: false, error: 'unknown', message: `${noun} ${id} is not ${context}` };
  if (ordered.length !== current.length)
    return {
      ok: false,
      error: 'missing',
      message: `the order must list every ${noun} ${context}`,
    };
  const updates: { id: T; sortOrder: number }[] = [];
  ordered.forEach((id, i) => {
    const sortOrder = (i + 1) * 10;
    const stored = current.find(r => r.id === id)?.sortOrder;
    if (stored !== sortOrder) updates.push({ id, sortOrder });
  });
  return { ok: true, updates };
}
