// Which tmux sessions this install may kill. Every session it spawns
// carries CYBERMOLE_SESSION_STAMP=<instance>:<generation>: the instance is
// this install's id (its state db's), the generation a digest of the code
// and the session env it was spawned under. Two rules, both scoped to
// sessions stamped with this instance — a socket can be shared (a dev
// server on the operator's default socket must never touch their tabs),
// and unstamped or foreign sessions are only reported:
//   - orphan: a tab session whose terminal row is gone (a best-effort kill
//     that missed). Rows are written before the spawn, so no race.
//   - stale: a tab session from another generation (a redeploy or a
//     config change). Killed at boot; its tab respawns on the next attach
//     with the current code and env.
import { createHash } from 'node:crypto';
import type { TerminalId, TmuxSessionName } from '@cybermole/app-kit';

export const SESSION_STAMP_VAR = 'CYBERMOLE_SESSION_STAMP';
export const INSTANCE_SETTING_KEY = 'sessions.instanceId';

const TAB_SESSION_RE = /^t-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Changes when the build or the env sessions are spawned with changes. */
export function sessionGeneration(buildMarker: string, env: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256')
    .update(buildMarker)
    .update('\0')
    .update(JSON.stringify(sorted))
    .digest('hex')
    .slice(0, 12);
}

export function sessionStamp(instance: string, generation: string): string {
  return `${instance}:${generation}`;
}

export interface SessionHygienePlan {
  orphans: TmuxSessionName[];
  stale: TmuxSessionName[];
  /** Not this install's (unstamped or another instance): never killed. */
  foreign: TmuxSessionName[];
}

/** sessions: live session → its stamp, null when it has none. */
export function planSessionHygiene(input: {
  sessions: Map<TmuxSessionName, string | null>;
  instance: string;
  generation: string;
  terminalIds: Set<TerminalId>;
}): SessionHygienePlan {
  const plan: SessionHygienePlan = { orphans: [], stale: [], foreign: [] };
  const current = sessionStamp(input.instance, input.generation);
  for (const [name, stamp] of input.sessions) {
    if (stamp === null || !stamp.startsWith(`${input.instance}:`)) {
      plan.foreign.push(name);
      continue;
    }
    const tab = TAB_SESSION_RE.exec(name);
    if (!tab) continue; // ours but not a tab (a job run): it ends with its command
    if (!input.terminalIds.has(tab[1] as TerminalId)) plan.orphans.push(name);
    else if (stamp !== current) plan.stale.push(name);
  }
  return plan;
}
