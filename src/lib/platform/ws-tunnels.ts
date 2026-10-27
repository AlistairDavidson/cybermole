// Per-token tracking of raw WS tunnels (the editor bridge, app tunnels), so
// logout/logout-all/shutdown can cut live sockets, not just future upgrades.
import type { SessionToken } from '@cybermole/app-kit';

/** Idempotent: closeToken may race a socket's own end. */
export interface TunnelHandle {
  close(): void;
}

export class TunnelTracker {
  private readonly byToken = new Map<SessionToken, Set<TunnelHandle>>();

  track(token: SessionToken, handle: TunnelHandle): void {
    let set = this.byToken.get(token);
    if (!set) {
      set = new Set();
      this.byToken.set(token, set);
    }
    set.add(handle);
  }

  untrack(token: SessionToken, handle: TunnelHandle): void {
    const set = this.byToken.get(token);
    if (!set) return;
    set.delete(handle);
    if (set.size === 0) this.byToken.delete(token);
  }

  closeToken(token: SessionToken): void {
    const set = this.byToken.get(token);
    if (!set) return;
    this.byToken.delete(token);
    for (const handle of set) handle.close();
  }

  closeAll(): void {
    for (const set of this.byToken.values()) for (const handle of set) handle.close();
    this.byToken.clear();
  }

  count(): number {
    let n = 0;
    for (const set of this.byToken.values()) n += set.size;
    return n;
  }
}
