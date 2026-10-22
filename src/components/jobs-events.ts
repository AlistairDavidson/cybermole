// jobs-events.ts — the jobs pages' /ws/events subscription (plan §7,
// "live consistency"). The service layer emits domain events at its
// choke points whoever acted (src/lib/events.ts); the server forwards
// them over this WebSocket; the page runs the SAME partial refresh its
// 15 s poll already runs, debounced — one rendering path, no granular
// DOM patching. The poll STAYS as the safety net (a dropped WS, a
// missed event, a failure anywhere — the page is at most 15 s stale).
//
// The WS reconnects with backoff like the terminal WS
// (agent-terminal.ts): 1 s doubling to 15 s, reset on a successful
// open, and a pending backoff fires as soon as the browser reports
// 'online' again.
//
// ACCEPTANCE LINE (plan §7): "a mutation over the internal socket (the
// agent path) updates an open jobs page without waiting for the poll —
// asserted in e2e." The orchestrator writes that e2e after merging the
// internal-socket branch (§3–§4); it mutates a job over the socket API
// and expects this subscription to refresh an open /jobs or /jobs/:name
// page well inside the 15 s poll.
import { BASE } from '../base';
import { debounceTrailing } from '../lib/debounce';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
/** Bus events can arrive in bursts (a save + a run, several jobs at
 *  once); one refresh per burst. */
const REFRESH_DEBOUNCE_MS = 250;

/** What the server sends (src/lib/events-ws.ts): a domain event, or one
 *  of the two control frames. Anything else — or nothing parseable at
 *  all — still means "something changed": an empty or unknown payload
 *  triggers the refresh too, never an error. */
type EventsFrame = { type?: string };

/** Open (and keep open) the /ws/events subscription for a page. Returns
 *  the teardown the page calls from disconnectedCallback. */
export function subscribeJobsEvents(onEvent: () => void): () => void {
  const refresh = debounceTrailing(onEvent, REFRESH_DEBOUNCE_MS);
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let final = false; // the server said signed-out — never reconnect
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
        /* garbage still means "refresh" below */
      }
      if (frame?.type === 'signed-out') {
        // The session died (logout / expiry): stop here. The page's own
        // next fetch 401s and navigates to /login.
        final = true;
        closedByUs = true;
        try {
          socket?.close();
        } catch {
          /* already closing */
        }
        return;
      }
      // 'restart' (server shutting down) behaves like a drop: the close
      // handler reconnects with backoff once the server is back.
      refresh();
    };
    socket.onclose = () => {
      if (closedByUs) return;
      socket = undefined;
      scheduleReconnect();
    };
    socket.onerror = () => {
      /* the close that follows does the work */
    };
  };

  // A pending backoff must not wait out its full delay once the browser
  // says the network is back (the terminal WS does the same on
  // visibility + online).
  const wake = (): void => {
    if (reconnectTimer === null || final || closedByUs) return;
    clearTimeout(reconnectTimer);
    connect();
  };
  window.addEventListener('online', wake);

  connect();

  return () => {
    closedByUs = true;
    refresh.cancel();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    window.removeEventListener('online', wake);
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    socket = undefined;
  };
}
