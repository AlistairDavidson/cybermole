// Pure order logic for a workspace's terminal tabs, shared by the tab bar
// (the optimistic move) and the domain (the persisted plan). Node-free, so
// the client bundle can ship it and the unit tests can hit it directly.
import type { TerminalId } from '@cybermole/app-kit';

/** Which command a tab runs on spawn and on respawn. */
export type TerminalCommand = 'agent' | 'shell';

/** A new array with items[from] moved to items[to]; out-of-range or a
 *  no-op returns a copy unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = [...items];
  if (from < 0 || from >= copy.length || to < 0 || to >= copy.length || from === to) return copy;
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved!);
  return copy;
}

export type ReorderPlan =
  | { ok: true; updates: { id: TerminalId; sortOrder: number }[] }
  | {
      ok: false;
      error: 'duplicate' | 'unknown_terminal' | 'missing_terminal';
      message: string;
    };

/** The persisted plan for a full-list reorder: `ordered` must be exactly
 *  the workspace's terminals, each once. Positions are steps of 10 (the
 *  append pattern), and terminals whose stored value already matches keep
 *  it — a no-op reorder writes nothing. */
export function reorderUpdates(
  current: readonly { id: TerminalId; sortOrder: number }[],
  ordered: readonly TerminalId[],
): ReorderPlan {
  if (new Set(ordered).size !== ordered.length)
    return { ok: false, error: 'duplicate', message: 'the order lists a terminal twice' };
  const have = new Set(current.map(t => t.id));
  for (const id of ordered)
    if (!have.has(id))
      return {
        ok: false,
        error: 'unknown_terminal',
        message: `terminal ${id} is not in this workspace`,
      };
  if (ordered.length !== current.length)
    return {
      ok: false,
      error: 'missing_terminal',
      message: 'the order must list every terminal in the workspace',
    };
  const updates: { id: TerminalId; sortOrder: number }[] = [];
  ordered.forEach((id, i) => {
    const sortOrder = (i + 1) * 10;
    const stored = current.find(t => t.id === id)?.sortOrder;
    if (stored !== sortOrder) updates.push({ id, sortOrder });
  });
  return { ok: true, updates };
}
