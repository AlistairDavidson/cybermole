// The console page's /ws/events subscription: the sidebar's state refresh
// (loadState) runs on workspaces/apps events instead of the retired 15 s
// poll. Reconnects with backoff like the terminal (1 s doubling to 15 s),
// waking early when the browser comes back online or visible; on socket
// open one re-sync load covers whatever happened while disconnected.
// Out-of-band liveness (a tmux session dying) arrives as the watcher's
// liveness_changed on the same socket. Jobs events are not ours: the /jobs
// page's own subscription refreshes on those.
import { BASE } from '../base';
import { debounceTrailing } from '../lib/platform/debounce';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
/** A mutation burst (a create auto-opens a tab, a delete cascades) is one refresh. */
const REFRESH_DEBOUNCE_MS = 250;

/** A domain event or a control frame. */
type EventsFrame = { topic?: string; type?: string };

/** Returns the teardown for disconnectedCallback. */
export function subscribeConsoleEvents(handlers: {
  /** A relevant event burst landed. */
  onEvent: () => void;
  /** The socket (re)opened: one re-sync load covers the gap. */
  onOpen: () => void;
}): () => void {
  const refresh = debounceTrailing(handlers.onEvent, REFRESH_DEBOUNCE_MS);
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let final = false; // signed out: never reconnect
  let closedByUs = false;

  const scheduleReconnect = (): void => {
    if (final || closedByUs) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(connect, delay);
  };

  const connect = (): void => {
    if (final || closedByUs) return;
    reconnectTimer = null;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${location.host}${BASE}/ws/events`);
    socket.onopen = () => {
      reconnectDelay = RECONNECT_MIN_MS;
      handlers.onOpen();
    };
    socket.onmessage = (ev: MessageEvent) => {
      let frame: EventsFrame | null = null;
      try {
        frame = JSON.parse(String(ev.data)) as EventsFrame;
      } catch {
        /* garbage is not ours; the poll this replaced is gone, so ignore it */
      }
      if (frame?.type === 'signed-out') {
        // The page's own next fetch 401s and goes to /login.
        final = true;
        closedByUs = true;
        try {
          socket?.close();
        } catch {
          /* already closing */
        }
        return;
      }
      // 'restart' acts like a drop: the close handler reconnects.
      if (frame?.topic === 'workspaces' || frame?.topic === 'apps') refresh();
    };
    socket.onclose = () => {
      if (closedByUs) return;
      socket = undefined;
      scheduleReconnect();
    };
    socket.onerror = () => {
      /* the close that follows handles it */
    };
  };

  // Hidden tabs' timers are throttled, so visibility is usually what fires.
  const wake = (): void => {
    if (reconnectTimer === null || final || closedByUs) return;
    if (document.visibilityState === 'hidden') return;
    clearTimeout(reconnectTimer);
    connect();
  };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);

  connect();

  return () => {
    closedByUs = true;
    refresh.cancel();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', wake);
    try {
      socket?.close();
    } catch {
      /* already closing */
    }
    socket = undefined;
  };
}
