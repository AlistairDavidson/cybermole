// Pure order logic for a workspace's terminal tabs, shared by the tab bar
// (the optimistic move) and the domain (the persisted plan). Node-free, so
// the client bundle can ship it and the unit tests can hit it directly.
// The plan itself is order-plan.ts's generic core (workspace rows and app
// groups reorder the same way); this wrapper keeps the terminal-specific
// error codes the domain maps onto.
import { orderPlan } from '../order-plan';
import type { TerminalId } from '@cybermole/app-kit';

export { moveItem } from '../order-plan';

/** Which command a tab runs on spawn and on respawn. */
export type TerminalCommand = 'agent' | 'shell';

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
  const plan = orderPlan(current, ordered, 'terminal', 'in this workspace');
  if (plan.ok) return plan;
  const error =
    plan.error === 'unknown'
      ? 'unknown_terminal'
      : plan.error === 'missing'
        ? 'missing_terminal'
        : 'duplicate';
  return { ok: false, error, message: plan.message } satisfies ReorderPlan;
}
