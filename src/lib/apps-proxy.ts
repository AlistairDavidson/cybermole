// apps-proxy.ts — the /apps/* reverse proxy (task/app-web,
// docs/plans/apps-plan.md §4): same-origin `${BASE}/apps/<slug>/*` forwarded
// VERBATIM (no prefix rewriting — the app's base path is baked in at
// build) over the app host's unix socket (CYBERMOLE_APPS_SOCK,
// server/app-host.ts), HTTP only (WS is plan §12). server/main.ts calls
// this behind the SAME session gate and origin checks as everything
// else — the /editor proxy's position in handle() is the model; apps
// are authenticated pages+API, never session-free.
//
// The decision surface AND the transport live here (the editor's split:
// decision in src/lib, transport in main.ts) because every rule is
// unit-testable against a real unix socket without booting the console:
// - CYBERMOLE_APPS_SOCK empty → the whole /apps/* namespace answers a
//   plain Result-JSON 404 (the API's notFound shape, never a crash);
// - a slug with NO db row → 404 BEFORE ever touching the host (the web
//   side owns the Apps domain — registration is what makes a slug
//   routable);
// - host socket unreachable/unanswering → 502 with a one-line body,
//   fast (a short idle timeout — a hung host must never stall a
//   request; the console's serving flag is the badge story);
// - request bodies forward with a sane cap (the console body policy's
//   shape: declared-length only, 413 over the cap).
import * as http from 'node:http';
import { AppSlugSchema, type AppSlug } from '@cybermole/app-kit';

/** The hop-by-hop set the editor proxy scrubs (src/lib/editor.ts) —
 *  connection-negotiating headers die at this hop by definition. */
export const APPS_HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
] as const;

/** The request-body cap for app POST/PATCH/DELETEs: generous for a
 *  Result-JSON API (the console's JSON routes cap at 10 KiB; an app's
 *  action bodies — a note, a form — can reasonably be larger), bounded
 *  so a runaway client cannot stream through the proxy unbounded. */
export const APPS_BODY_MAX_BYTES = 1024 * 1024;

/** Idle timeout on the proxied upstream request: connect errors over a
 *  unix socket are instant (ECONNREFUSED), but a listener that ACCEPTED
 *  and then wedged would hang the browser tab forever — past this the
 *  request is destroyed and the console answers 502. Local-socket SSR
 *  pages answer in milliseconds; anything slower is a broken host. */
export const APPS_PROXY_IDLE_MS = 10_000;

export interface AppsProxyDeps {
  /** URL base path ('/' or '/foo') — the console's CFG.base. */
  base: string;
  /** The resolved apps socket (env.ts readAppsSocket) — null = the apps
   *  surface is OFF (CYBERMOLE_APPS_SOCK empty): the whole namespace
   *  answers the Result-JSON 404 below, whatever the row state. */
  socketPath: string | null;
  /** Does this slug have a db row? (main.ts over services.apps — the
   *  web side's Apps domain; the proxy 404s unknown slugs before ever
   *  touching the host.) Null = the state db could not be read: fail
   *  closed with 503, like the session store's unreadable stance. */
  registered: (slug: AppSlug) => boolean | null;
  /** Idle timeout override (units inject milliseconds). */
  idleTimeoutMs?: number;
}

function basePath(base: string): string {
  return base === '/' ? '/apps' : base + '/apps';
}

/** Does this request path belong to the apps proxy? `${BASE}/apps` and
 *  everything below it; `/appsylvania` must NOT match. */
export function isAppsHttpPath(base: string, url: string): boolean {
  return url === basePath(base) || url.startsWith(basePath(base) + '/');
}

/** The slug segment of an /apps path (RAW, undecoded — AppSlugSchema
 *  validates it), or null for `/apps` and `/apps/` themselves (no slug
 *  at all: the namespace's bare root, answered like an unknown slug). */
export function appsSlugOf(base: string, url: string): string | null {
  if (!isAppsHttpPath(base, url)) return null;
  const rest = url.slice(basePath(base).length);
  const first = rest.split('/')[1] ?? '';
  return first === '' ? null : first;
}

/** 413 (declared length over the cap), 411 (length-less chunked body —
 *  the console API's stance; browsers send Content-Length for every
 *  body an app's pages post) or null (within the cap). */
export function appsBodyCapStatus(req: {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}): 411 | 413 | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const declared = req.headers['content-length'];
  if (declared === undefined) {
    return req.headers['transfer-encoding'] !== undefined ? 411 : null;
  }
  return Number(declared) <= APPS_BODY_MAX_BYTES ? null : 413;
}

function send(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** The namespace's one 404 body: the API's notFound shape verbatim
 *  (server/internal-api.ts), never a crash and never HTML. */
function sendAppsNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'not found', detail: null, code: 'not_found' }));
}

/** The whole /apps/* branch, minus the session gate that already ran in
 *  main.ts: off-surface → 404, slugless/unknown slug → 404 (before any
 *  socket is touched), unreadable state → 503, then body-cap checks and
 *  the verbatim forward. */
export function handleAppsRequest(
  deps: AppsProxyDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (deps.socketPath === null) {
    sendAppsNotFound(res);
    return;
  }
  const raw = appsSlugOf(deps.base, req.url ?? '/');
  const slug = raw === null ? null : AppSlugSchema.safeParse(raw);
  if (!slug?.success) {
    sendAppsNotFound(res);
    return;
  }
  const known = deps.registered(slug.data);
  if (known === null) {
    send(res, 503, 'state store unavailable, try again');
    return;
  }
  if (!known) {
    sendAppsNotFound(res);
    return;
  }
  const capped = appsBodyCapStatus(req);
  if (capped === 413) {
    send(res, 413, 'request body too large');
    return;
  }
  if (capped === 411) {
    send(res, 411, 'request body needs a Content-Length');
    return;
  }
  proxyAppsRequest(deps.socketPath, req, res, deps.idleTimeoutMs);
}

/** The transport: headers through (minus hop-by-hop AND the session
 *  cookie — app code has exactly a terminal's powers, plan §8, and the
 *  console's session token must never become one of them), request body
 *  piped, answer's headers+body streamed back. Paths forward verbatim:
 *  both `/apps/<slug>` and `/apps/<slug>/` answer 200 through the app's
 *  own middleware (the fixture's baked-base behavior — no redirect is
 *  synthesized). */
function proxyAppsRequest(
  socketPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  idleTimeoutMs?: number,
): void {
  const headers = { ...req.headers };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- scrubbing the hop-by-hop header set
  for (const hop of APPS_HOP_BY_HOP_HEADERS) delete headers[hop];
  // The console session cookie stays in the web process: an app reading
  // it could replay the token against the console — a power NO terminal
  // has, and apps have exactly a terminal's powers (apps-plan §8).
  delete headers.cookie;
  const proxied = http.request(
    { socketPath, method: req.method, path: req.url, headers },
    upstreamRes => {
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (Array.isArray(value)) out[name] = value.join(', ');
        else if (value !== undefined) out[name] = value;
      }
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- scrubbing the hop-by-hop header set
      for (const hop of APPS_HOP_BY_HOP_HEADERS) delete out[hop];
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(res);
    },
  );
  proxied.setTimeout(idleTimeoutMs ?? APPS_PROXY_IDLE_MS, () =>
    proxied.destroy(new Error('app host idle')),
  );
  proxied.on('error', () => {
    // One line, honest, no stack: the console's serving flag (the
    // /api/state host ping) is the visible badge for this condition.
    if (!res.headersSent) send(res, 502, 'app host unavailable');
    else res.destroy();
  });
  req.pipe(proxied);
}
