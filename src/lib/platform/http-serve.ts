// The HTTP serving plumbing shared by the node servers — main.ts's console
// host and app-host.ts: the send helpers, security-header hardening, access
// logging, and the containment-checked static-file serve. Routing, gates and
// body policy stay with each host.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

// The union of what the console's client dir and an app's dist/client ship;
// anything else answers application/octet-stream.
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Sets no Content-Type: pass one through `headers` when the client cares. */
export function send(
  res: http.ServerResponse,
  code: number,
  body: string,
  headers?: Record<string, string>,
): void {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function sendText(res: http.ServerResponse, code: number, body: string): void {
  send(res, code, body, { 'Content-Type': 'text/plain; charset=utf-8' });
}

export function sendJSON(res: http.ServerResponse, code: number, body: unknown): void {
  send(res, code, JSON.stringify(body), { 'Content-Type': 'application/json' });
}

// ---------- security headers ----------
// xterm and Lit inject <style> at runtime, hence 'unsafe-inline' styles;
// wss: is for older Safari, where 'self' doesn't cover it. Only filled in
// where absent, so a handler's (or an app's) own headers win.
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' wss:; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/** Apply the security headers on writeHead or end, whichever comes first,
 *  without overriding any a handler set itself. */
export function hardenResponse(res: http.ServerResponse): void {
  const apply = (): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!res.hasHeader(name)) res.setHeader(name, value);
    }
  };
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
  const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
  res.writeHead = ((...args: unknown[]) => {
    apply();
    return writeHead(...args);
  }) as typeof res.writeHead;
  res.end = ((...args: unknown[]) => {
    apply();
    return end(...args);
  }) as typeof res.end;
}

/** For upgrade rejections, written straight to the socket. */
export function securityHeaderBlock(): string {
  return Object.entries(SECURITY_HEADERS)
    .map(([n, v]) => `${n}: ${v}\r\n`)
    .join('');
}

// ---------- access log ----------
/** Structural, so tests can pass plain objects. */
export interface AccessLog {
  debug(message: string): void;
  http(message: string): void;
}

/** One line per finished response. `quiet` paths (hot polls, assets) drop to
 *  debug — silent on the console, still pushed to loki. */
export function logAccess(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  log: AccessLog,
  quiet?: (path: string) => boolean,
): void {
  const start = Date.now();
  res.on('finish', () => {
    const p = (req.url ?? '').split('?')[0] ?? '';
    const line = `${req.method} ${p} ${res.statusCode} in ${Date.now() - start}ms`;
    if (quiet?.(p)) log.debug(line);
    else log.http(line);
  });
}

// ---------- static files ----------
/** `rel` under `dir` as a normalized absolute path, or null when it escapes
 *  the directory (traversal — the caller decides how to refuse). */
export function resolveUnderDir(dir: string, rel: string): string | null {
  const file = path.normalize(path.join(dir, rel));
  return file.startsWith(dir + path.sep) ? file : null;
}

/** 200 with the file's MIME type, or `onMiss` when the read fails (a
 *  stat/read race, a vanished file). `cache` is for hashed immutable assets;
 *  everything else is no-store. */
export function sendStaticFile(
  res: http.ServerResponse,
  file: string,
  cache: boolean,
  onMiss?: (res: http.ServerResponse) => void,
): void {
  fs.readFile(file, (err, data) => {
    if (err) {
      if (onMiss) onMiss(res);
      else send(res, 404, 'not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-store',
    });
    res.end(data);
  });
}
