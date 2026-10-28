// The live-update half of the component architecture (CODE_STYLE.md §7):
// the WS is a doorbell — small typed event frames in, never domain state
// out. createAppSocket owns the connection so every app gets the same
// reconnect discipline: the host cuts tunnels on logout or token expiry
// without a close handshake, so clients reconnect with a capped backoff.
// An effect answers a frame by refreshing data through the typed route
// client (the action) and updating the DOM surgically.
import type { z } from 'zod';

/** Capped exponential backoff: baseMs * 2^(attempt-1), capped at capMs. */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 15000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, capMs);
}

export interface AppSocketOptions<Frame> {
  /** ws/wss URL, built per (re)connect. */
  url: () => string;
  /** Frames are zod-validated; anything else is dropped, never fatal. */
  frame: z.ZodType<Frame>;
  onFrame: (frame: Frame) => void;
  onOpen?: () => void;
}

export interface AppSocket {
  /** Stops reconnecting too, not just the current socket. */
  close(): void;
}

export function createAppSocket<Frame>(options: AppSocketOptions<Frame>): AppSocket {
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = (): void => {
    if (closed) return;
    const ws = new WebSocket(options.url());
    ws.onopen = () => {
      attempt = 0;
      options.onOpen?.();
    };
    ws.onmessage = event => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const result = options.frame.safeParse(parsed);
      if (result.success) options.onFrame(result.data);
    };
    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(connect, backoffDelay(++attempt));
    };
    // A socket that errors always closes right after; onclose is the one
    // reconnect path, so onerror stays empty on purpose.
    ws.onerror = (): void => undefined;
  };
  connect();
  return {
    close(): void {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
