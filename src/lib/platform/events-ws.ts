// /ws/events: browsers' subscription to the domain-event bus. The upgrade
// gate is a function so it's unit-testable; the relay forwards bus events
// verbatim as JSON and ends sockets whose token dies.
//
// Server → client only: domain events, then a final {type:'signed-out'}
// (don't reconnect) or {type:'restart'} (reconnect with backoff).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { onDomainEvent, type DomainEvent } from './events';
import type { SessionCheckResult } from './auth';
import type { SessionToken } from '@cybermole/app-kit';

/** 'destroy' refuses silently, like the terminal; 'status' writes an HTTP status line first. */
export type EventsUpgradeDecision =
  | { ok: true; token: SessionToken }
  | { ok: false; reply: 'destroy'; why: string }
  | { ok: false; reply: 'status'; status: string; why: string };

export interface EventsUpgradeChecks {
  shuttingDown(): boolean;
  allow(ip: string): boolean;
  originOk(req: IncomingMessage): boolean;
  validSession(cookie: string | undefined): SessionCheckResult;
}

/** Same order and semantics as the terminal's gate; `why` is for the caller's log line. */
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

/** alive must never renew the token. */
export interface EventsRelayDeps {
  alive(token: SessionToken): SessionCheckResult;
  log: EventsLog;
  /** default 30 s */
  pingMs?: number;
}

/** Structural, so tests can pass plain functions. */
export interface EventsLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const DEFAULT_PING_MS = 30_000;

/** A peer that never answers the close frame is terminated. */
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

  /** Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onDomainEvent(event => this.broadcast(event));
  }

  /** The upgrade is already gated. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, token: SessionToken): void {
    this.wss.handleUpgrade(req, socket, head, ws => this.attach(ws, token));
  }

  private broadcast(event: DomainEvent): void {
    const frame = JSON.stringify(event);
    for (const set of this.byToken.values()) {
      for (const ws of set) {
        try {
          if (ws.readyState === ws.OPEN) ws.send(frame);
        } catch {
          /* the poll is the safety net */
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
    // Like the terminal's keepalive: a missed pong means the peer is gone,
    // and a dead token ends the socket rather than keep streaming job names
    // to a signed-out browser.
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
            // can't tell; recheck next sweep
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
      /* the client never sends */
    });
    ws.on('close', () => {
      clearInterval(keepalive);
      const sockets = this.byToken.get(token);
      if (!sockets) return;
      sockets.delete(ws);
      if (sockets.size === 0) this.byToken.delete(token);
    });
  }

  closeToken(token: SessionToken, final: { type: 'signed-out' } | { type: 'restart' }): void {
    const set = this.byToken.get(token);
    if (!set) return;
    this.byToken.delete(token);
    for (const ws of set) {
      this.sendFinal(ws, final);
      closeSoon(ws);
    }
  }

  closeAll(final: { type: 'signed-out' } | { type: 'restart' }): void {
    for (const set of this.byToken.values()) {
      for (const ws of set) {
        this.sendFinal(ws, final);
        closeSoon(ws);
      }
    }
    this.byToken.clear();
  }

  /** Shutdown: unsubscribe and close every socket. */
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
