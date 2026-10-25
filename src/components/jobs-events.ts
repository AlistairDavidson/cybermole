// The jobs pages' /ws/events subscription: on any domain event, re-run the
// same partial refresh the 15 s poll runs, debounced. The poll stays as the
// safety net. Reconnects with backoff like the terminal (1 s doubling to
// 15 s), waking early when the browser comes back online or visible.
import { BASE } from '../base';
import { debounceTrailing } from '../lib/platform/debounce';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
/** Events come in bursts; one refresh per burst. */
const REFRESH_DEBOUNCE_MS = 250;

/** A domain event or a control frame. Anything unparseable still triggers a refresh. */
type EventsFrame = { type?: string };

/** Returns the teardown for disconnectedCallback. */
export function subscribeJobsEvents(onEvent: () => void): () => void {
  const refresh = debounceTrailing(onEvent, REFRESH_DEBOUNCE_MS);
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
    };
    socket.onmessage = (ev: MessageEvent) => {
      let frame: EventsFrame | null = null;
      try {
        frame = JSON.parse(String(ev.data)) as EventsFrame;
      } catch {
        /* garbage still refreshes below */
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
      refresh();
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
      /* already closed */
    }
    socket = undefined;
  };
}
