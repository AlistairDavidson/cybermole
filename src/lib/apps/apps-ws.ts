// WS upgrade proxying for `${BASE}/apps/<slug>/*`: the SAME gate family as
// the events socket (checkEventsUpgrade — shared, not forked), then a raw
// bidirectional tunnel to the app host's unix socket, shaped like the
// editor's WS bridge in server/main.ts (forward the upgrade, pipe both
// ways, sweep for token expiry, clean teardown both ways).
//
// The app side of the contract is the optional ws entry — dist/server/ws.mjs
// exporting handleUpgrade(req, socket, head) — documented in the app-starter
// template's README (runtime/app-starter/README.md § WebSocket routes).
import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { AppSlugSchema, type AppSlug, type SessionToken } from '@cybermole/app-kit';
import { APPS_HOP_BY_HOP_HEADERS, APPS_PROXY_IDLE_MS, appsSlugOf } from './apps-proxy';
import type { EventsUpgradeDecision, EventsLog } from '../platform/events-ws';
import type { SessionCheckResult } from '../platform/auth';
import type { TunnelHandle } from '../platform/ws-tunnels';

/** Strip hop-by-hop and the session cookie, then re-add the upgrade pair:
 *  without `Connection: Upgrade` the app host sees a plain GET and never
 *  answers 101. The cookie strip matches the HTTP proxy — an app must not
 *  be able to replay the token against the console. */
export function appsUpgradeHeaders(
  incoming: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...incoming };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- scrubbing the hop-by-hop header set
  for (const hop of APPS_HOP_BY_HOP_HEADERS) delete headers[hop];
  delete headers.cookie;
  headers.connection = 'Upgrade';
  headers.upgrade =
    typeof incoming.upgrade === 'string' && incoming.upgrade !== ''
      ? incoming.upgrade
      : 'websocket';
  return headers;
}

export interface AppsWsLog extends EventsLog {
  error(message: string, meta?: { error: unknown }): void;
  debug(message: string): void;
}

export interface AppsWsDeps {
  /** '/' or '/foo' */
  base: string;
  /** null: apps off, so upgrades refuse like the HTTP proxy's 404. */
  socketPath: string | null;
  /** null: the state db couldn't be read; fail closed with 503. */
  registered: (slug: AppSlug) => boolean | null;
  /** The already-computed decision from checkEventsUpgrade (the shared gate). */
  gate: EventsUpgradeDecision;
  /** Status-line refusals carry the security headers (main.ts's block). */
  securityHeaders: string;
  track(token: SessionToken, handle: TunnelHandle): void;
  untrack(token: SessionToken, handle: TunnelHandle): void;
  /** Expiry sweep; must never renew the token. */
  alive(token: SessionToken): SessionCheckResult;
  log: AppsWsLog;
  /** Upgrade-phase idle cap; a wedged host must refuse, not hang (the HTTP
   *  proxy's budget by default). */
  idleTimeoutMs?: number;
  /** Token-expiry sweep cadence, default 30 s. */
  sweepMs?: number;
}

const DEFAULT_SWEEP_MS = 30_000;

/** A refusal is an HTTP status line straight to the socket (an upgrade has
 *  no res), then teardown — never a hang. */
function refuse(socket: Duplex, deps: AppsWsDeps, status: string): void {
  if (socket.destroyed) return;
  // The write can race a client reset; an async write error with no
  // listener would take the whole process down.
  socket.on('error', () => undefined);
  socket.write(`HTTP/1.1 ${status}\r\n${deps.securityHeaders}\r\n`);
  socket.destroy();
}

/** The gates have already run upstream of this call. */
export function handleAppsUpgrade(
  deps: AppsWsDeps,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const gate = deps.gate;
  if (!gate.ok) {
    deps.log.warn(`apps ws upgrade rejected: ${gate.why}`);
    if (gate.reply === 'status') refuse(socket, deps, gate.status);
    else socket.destroy();
    return;
  }
  if (deps.socketPath === null) {
    deps.log.warn('apps ws upgrade refused: apps surface off');
    refuse(socket, deps, '404 Not Found');
    return;
  }
  const raw = appsSlugOf(deps.base, req.url ?? '/');
  const slug = raw === null ? null : AppSlugSchema.safeParse(raw);
  if (!slug?.success) {
    refuse(socket, deps, '404 Not Found');
    return;
  }
  const known = deps.registered(slug.data);
  if (known === null) {
    refuse(socket, deps, '503 Service Unavailable');
    return;
  }
  if (!known) {
    refuse(socket, deps, '404 Not Found');
    return;
  }
  tunnelAppsUpgrade(deps, deps.socketPath, gate.token, req, socket, head);
}

/** Raw byte tunnel to the app host's socket; every gate has passed. */
function tunnelAppsUpgrade(
  deps: AppsWsDeps,
  socketPath: string,
  token: SessionToken,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const headers = appsUpgradeHeaders(req.headers);
  const proxied = http.request({
    socketPath,
    method: 'GET',
    path: req.url,
    headers,
  });
  // From here until the 101 lands, the client socket's errors would
  // otherwise be unhandled (fatal to the process) and a dead client would
  // wedge the upstream request until the idle cap. Post-101, done() below
  // owns teardown; destroying the detached request then is harmless.
  socket.on('error', () => proxied.destroy());
  socket.on('close', () => proxied.destroy());
  proxied.setTimeout(deps.idleTimeoutMs ?? APPS_PROXY_IDLE_MS, () =>
    proxied.destroy(new Error('app host upgrade idle')),
  );
  proxied.on('error', err => {
    // The client may have gone first (its close/error destroys proxied);
    // then there is nothing left to tell.
    if (socket.destroyed) return;
    deps.log.error('apps ws upgrade failed', { error: err });
    // Like the HTTP proxy's 502: a down host refuses, never hangs.
    refuse(socket, deps, '502 Bad Gateway');
  });
  // Non-101 answer: forward the status and end.
  proxied.on('response', upstreamRes => {
    socket.on('error', () => undefined); // a racing client reset must stay handled
    socket.write(
      `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ''}\r\n` +
        'Connection: close\r\n\r\n',
    );
    socket.destroy();
  });
  proxied.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        Object.entries(upstreamRes.headers)
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    const tunnel: TunnelHandle = {
      close(): void {
        socket.destroy();
        upstreamSocket.destroy();
      },
    };
    deps.track(token, tunnel);
    // WS traffic never renews a token, so expiry must be checked here.
    const sweep = setInterval(() => {
      const alive = deps.alive(token);
      if (alive.ok) return;
      if (alive.errorCode === 'no_session') {
        deps.log.info('apps ws tunnel closed: session ended');
        done();
        return;
      }
      // database_error: re-check next tick rather than cut an app over a db hiccup.
    }, deps.sweepMs ?? DEFAULT_SWEEP_MS).unref();
    const done = (): void => {
      clearInterval(sweep);
      deps.untrack(token, tunnel);
      tunnel.close();
    };
    socket.on('close', done);
    upstreamSocket.on('close', done);
    socket.on('error', done);
    upstreamSocket.on('error', done);
    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    deps.log.debug('apps ws tunnel established');
  });
  proxied.end();
}
