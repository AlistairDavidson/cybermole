// The /apps/* reverse proxy: `${BASE}/apps/<slug>/*` forwarded verbatim (the
// app's base is baked in at build) to the app host's unix socket, behind
// main.ts's session gate. HTTP only.
//
// Apps off → JSON 404. Unregistered slug → 404 before touching the host.
// Host unreachable or wedged → a fast 502.
import * as http from 'node:http';
import { AppSlugSchema, type AppSlug } from '@cybermole/app-kit';

export const APPS_HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
] as const;

/** Larger than the console's 10 KiB (an app's notes and forms), but bounded. */
export const APPS_BODY_MAX_BYTES = 1024 * 1024;

/** A host that accepted then wedged would otherwise hang the tab forever. */
export const APPS_PROXY_IDLE_MS = 10_000;

export interface AppsProxyDeps {
  /** '/' or '/foo' */
  base: string;
  /** null: apps off, so the whole namespace 404s. */
  socketPath: string | null;
  /** null: the state db couldn't be read; fail closed with 503. */
  registered: (slug: AppSlug) => boolean | null;
  /** for tests */
  idleTimeoutMs?: number;
}

function basePath(base: string): string {
  return base === '/' ? '/apps' : base + '/apps';
}

/** `${BASE}/apps` and below; `/appsylvania` must not match. */
export function isAppsHttpPath(base: string, url: string): boolean {
  return url === basePath(base) || url.startsWith(basePath(base) + '/');
}

/** Raw (AppSlugSchema validates it); null for the bare `/apps` root. */
export function appsSlugOf(base: string, url: string): string | null {
  if (!isAppsHttpPath(base, url)) return null;
  const rest = url.slice(basePath(base).length);
  const first = rest.split('/')[1] ?? '';
  return first === '' ? null : first;
}

/** 411 for chunked bodies, like the console API. */
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

/** The API's notFound shape, never HTML. */
function sendAppsNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'not found', detail: null, code: 'not_found' }));
}

/** The session gate has already run. */
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

/** Paths forward verbatim; hop-by-hop headers and the session cookie are stripped. */
function proxyAppsRequest(
  socketPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  idleTimeoutMs?: number,
): void {
  const headers = { ...req.headers };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- scrubbing the hop-by-hop header set
  for (const hop of APPS_HOP_BY_HOP_HEADERS) delete headers[hop];
  // Apps get a terminal's powers, not the console's: a cookie would let
  // an app replay the token against the console.
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
    // The console's serving flag is the visible signal for this.
    if (!res.headersSent) send(res, 502, 'app host unavailable');
    else res.destroy();
  });
  req.pipe(proxied);
}
