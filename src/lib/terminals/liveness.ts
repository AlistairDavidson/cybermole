// Out-of-band liveness: a tmux session dying (or a job run ending) changes
// the sidebar's live dots with no mutation hook to emit from, so this cheap
// watcher diffs the live-session set and publishes liveness_changed onto the
// bus when it moves. The console page has no poll anymore; this is what
// heals its dots — one `tmux list-sessions` per interval, nothing else.
import { emitDomainEvent } from '../platform/events';
import type { TmuxSessionName } from '@cybermole/app-kit';

export interface LivenessWatchDeps {
  /** Can't fail: a down tmux server reads as nothing live. */
  liveSessionNames: () => Promise<Set<TmuxSessionName>>;
  /** default 10 s; must stay under the retired poll's 15 s heal window. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 10_000;

function sameSet(a: Set<TmuxSessionName>, b: Set<TmuxSessionName>): boolean {
  if (a.size !== b.size) return false;
  for (const name of a) if (!b.has(name)) return false;
  return true;
}

/** Starts the watch; the return value stops it (shutdown). */
export function startLivenessWatch(deps: LivenessWatchDeps): () => void {
  // null until the first probe lands: the baseline is taken silently, so a
  // fresh boot doesn't broadcast what every page loads on connect anyway.
  let previous: Set<TmuxSessionName> | null = null;
  const timer = setInterval(() => {
    void deps
      .liveSessionNames()
      .then(live => {
        if (previous !== null && !sameSet(previous, live))
          emitDomainEvent({ topic: 'workspaces', type: 'liveness_changed' });
        previous = live;
      })
      .catch(() => {
        /* a failed probe keeps the last baseline; the next tick retries */
      });
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
