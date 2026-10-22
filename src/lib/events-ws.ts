// events-ws.ts — /ws/events: the browser's subscription to the domain
// event bus (src/lib/events.ts). Two halves, both unit-tested
// (tests/unit/events-ws.test.mjs):
//
// - checkEventsUpgrade: the cookie gate. server/main.ts applies the SAME
//   gates as the terminal WS (shutdown, the shared ws rate limiter,
//   Origin, the session cookie) but through this one function, so the
//   decision logic itself is testable without booting main.ts.
// - EventsRelay: everything after a successful upgrade. Owns its
//   WebSocketServer, tracks sockets per session token, forwards bus
//   events as small JSON frames ({topic:'jobs', type, job, firedAt?}),
//   and keeps the socket alive (ping + a token liveness sweep, like the
//   terminal's — a dead token must not ride the keepalive forever).
//
// Wire frames, server → client only (the client never sends):
//   a domain event  — the bus event, verbatim JSON
//   {type:'signed-out'} — the token died (logout / expiry): final, the
//                     client must not reconnect
//   {type:'restart'}    — the server is shutting down: reconnect with
//                     backoff once it's back
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { onDomainEvent, type DomainEvent } from './events';
import type { SessionCheckResult } from './auth';
import type { SessionToken } from '../types/branded';

/** The gate's verdict: allow (with the authenticated token), destroy the
 *  socket silently (shutdown / rate limit / Origin — no reply, exactly
 *  like the terminal's refusals), or answer an HTTP status line first
 *  (session gate: 401 signed out, 503 store down). */
export type EventsUpgradeDecision =
  | { ok: true; token: SessionToken }
  | { ok: false; reply: 'destroy'; why: string }
  | { ok: false; reply: 'status'; status: string; why: string };

/** main.ts's own primitives, injected: the relay never re-derives them. */
export interface EventsUpgradeChecks {
  shuttingDown(): boolean;
  /** the shared WS upgrade rate limiter's allow() */
  allow(ip: string): boolean;
  originOk(req: IncomingMessage): boolean;
  /** auth.valid(Auth.sessionToken(cookie)) — the cookie gate */
  validSession(cookie: string | undefined): SessionCheckResult;
}

/** Gate one /ws/events upgrade. Same order and semantics as the
 *  terminal's branch in server/main.ts; the `why` strings are for the
 *  log lines the caller writes on refusal. */
export function checkEventsUpgrade(
  req: IncomingMessage,
  ip: string,
  checks: EventsUpgradeChecks,
): EventsUpgradeDecision {
  if (checks.shuttingDown()) return { ok: false, reply: 'destroy', why: 'server shutting down' };
  if (!checks.allow(ip)) return { ok: false, reply: 'destroy', why: 'rate-limited' };
  const origin = req.headers.origin;
  if (!origin || !checks.originOk(req))
    return { ok: false, reply: 'destroy', why: 'missing or mismatched Origin' };
  const session = checks.validSession(req.headers.cookie);
  if (!session.ok) {
    switch (session.errorCode) {
      case 'no_session':
        return { ok: false, reply: 'status', status: '401 Unauthorized', why: 'no valid session' };
      case 'database_error':
        return {
          ok: false,
          reply: 'status',
          status: '503 Service Unavailable',
          why: session.errorMessage ?? 'session store unavailable',
        };
      default:
        return session satisfies never;
    }
  }
  return { ok: true, token: session.data.token };
}

/** What the relay needs from main.ts: the token liveness peek
 *  (auth.alive — never renewing) and a logger for the sweep's db lines. */
export interface EventsRelayDeps {
  alive(token: SessionToken): SessionCheckResult;
  log: EventsLog;
  /** keepalive ping interval (default 30 s, like the terminal's) */
  pingMs?: number;
}

/** The slice of a winston logger the relay uses (structural, so tests
 *  can pass plain functions). */
export interface EventsLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const DEFAULT_PING_MS = 30_000;

/** Close with a hard fallback (the terminal's closeSoon semantics): a
 *  peer that never answers the close frame is terminated. */
function closeSoon(ws: WebSocket): void {
  try {
    ws.close();
  } catch {
    /* already closed */
  }
  setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      /* gone */
    }
  }, 1500).unref();
}

export class EventsRelay {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private readonly byToken = new Map<SessionToken, Set<WebSocket>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: EventsRelayDeps) {}

  /** Subscribe to the bus. Called once at boot; idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onDomainEvent(event => this.broadcast(event));
  }

  /** Complete an upgrade main.ts has already gated. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, token: SessionToken): void {
    this.wss.handleUpgrade(req, socket, head, ws => this.attach(ws, token));
  }

  /** Forward one event to every open socket (a send failure on one socket
   *  must not starve the others — ws buffers and errors async). */
  private broadcast(event: DomainEvent): void {
    const frame = JSON.stringify(event);
    for (const set of this.byToken.values()) {
      for (const ws of set) {
        try {
          if (ws.readyState === ws.OPEN) ws.send(frame);
        } catch {
          /* a dying socket drops the event — the poll is the safety net */
        }
      }
    }
  }

  private attach(ws: WebSocket, token: SessionToken): void {
    let set = this.byToken.get(token);
    if (!set) {
      set = new Set();
      this.byToken.set(token, set);
    }
    set.add(ws);
    // Keepalive, same shape as a terminal's: the ping counts as traffic
    // for idle-timeout proxies; a peer that misses a full interval is
    // gone; and the token itself must stay alive — WS traffic never
    // slides it (auth.alive never renews), so a token that died on
    // either clock — idle, the absolute cap, a logout — ends its event
    // sockets instead of leaking job names at a signed-out browser.
    let alive = true;
    const keepalive = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      const live = this.deps.alive(token);
      if (!live.ok) {
        switch (live.errorCode) {
          case 'no_session':
            this.closeToken(token, { type: 'signed-out' });
            return;
          case 'database_error':
            // can't tell — recheck next sweep, like the terminal's
            this.deps.log.error(`session store unavailable: ${live.errorMessage}`);
            break;
          default:
            live satisfies never;
        }
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }, this.deps.pingMs ?? DEFAULT_PING_MS);
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', () => {
      /* the client never sends; ignore anything, never throw */
    });
    ws.on('close', () => {
      clearInterval(keepalive);
      const sockets = this.byToken.get(token);
      if (!sockets) return;
      sockets.delete(ws);
      if (sockets.size === 0) this.byToken.delete(token);
    });
  }

  /** Send `final`, then end every event socket authenticated with
   *  `token` (logout, log out everywhere, a dead token's sweep). */
  closeToken(token: SessionToken, final: { type: 'signed-out' } | { type: 'restart' }): void {
    const set = this.byToken.get(token);
    if (!set) return;
    this.byToken.delete(token);
    for (const ws of set) {
      this.sendFinal(ws, final);
      closeSoon(ws);
    }
  }

  /** Send `final`, then end every event socket (shutdown). */
  closeAll(final: { type: 'signed-out' } | { type: 'restart' }): void {
    for (const set of this.byToken.values()) {
      for (const ws of set) {
        this.sendFinal(ws, final);
        closeSoon(ws);
      }
    }
    this.byToken.clear();
  }

  /** Stop the relay for good: unsubscribe from the bus and close every
   *  socket (the shutdown path — clients reconnect once the server is
   *  back). */
  stop(final: { type: 'signed-out' } | { type: 'restart' }): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.closeAll(final);
  }

  private sendFinal(ws: WebSocket, final: { type: 'signed-out' } | { type: 'restart' }): void {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(final));
    } catch {
      /* already closing */
    }
  }
}
