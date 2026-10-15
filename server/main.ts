#!/usr/bin/env node
// main.ts — web-pi server.
// One process: serves the Astro SSR build (pages via the middleware handler,
// hashed assets statically), the REST API, and the WS→node-pty→tmux
// terminal. Loopback by default; put it behind a TLS reverse proxy
// (deploy/nginx-webpi.conf). Config: WEB_PI_* env (README table).
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
// @ts-ignore — no bundled types for the native module
import * as pty from 'node-pty';
import { Auth, RateLimiter, type Auth as AuthType } from '../src/lib/auth';
import { StateDb } from '../src/lib/db';
import * as tmux from '../src/lib/tmux';
import { ENV, RAW_ENV, APP_ROOT, PI_BIN, PI_AGENT_DIR, PI_SESSION_DIR, readObjectStoreConfig, readEditorUpstream, RELEASES_DIR } from '../src/lib/env';
import { componentLogger, closeLogger } from '../src/lib/logger';
import * as jobs from '../src/lib/jobs';
import { AutoUpdater } from '../src/lib/auto-update';
import {
  EDITOR_HOP_BY_HOP_HEADERS, EDITOR_MAX_BODY_BYTES, EditorTunnelTracker, editorBodyCapStatus,
  editorSecurityHeaders, editorUpgradeHeaders, isEditorHttpPath, isEditorUpgradePath, type EditorUpstream,
} from '../src/lib/editor';
import { createServices, type ServerConfig, type WebPiLocals } from '../src/lib/services';
import { resolveServingDirs } from '../src/lib/releases';
import { ObjectStore } from '../src/lib/storage';
import type { ClientMsg, ServerMsg } from '../src/lib/types';
import { loginBody } from '../src/schemas/api';
import { parseClientMsg } from '../src/schemas/frames';
import { TerminalIdSchema, TmuxSessionNameSchema } from '../src/schemas/ids';
import { UPLOAD_MAX_BODY_BYTES } from '../src/schemas/uploads';
import type { SessionToken, TmuxSessionName } from '../src/types/branded';

// Operational logging (src/lib/logger.ts): console always; a winston-loki
// push transport when WEB_PI_LOKI_URL is set. Component children give every
// line its [component] console prefix / loki label. set-password.ts keeps
// plain console.* — CLI output for a human at a terminal, no server.
const bootLog = componentLogger('boot');
const httpLog = componentLogger('http');
const authLog = componentLogger('auth');
const wsLog = componentLogger('ws');
const shutdownLog = componentLogger('shutdown');

// URL base path ('/' or '/foo', no trailing slash). Must match the base
// the pages were built with (astro.config.mjs reads the same env at build).
function normalizeBase(raw: string): string {
  let b = (raw || '/').trim();
  if (!b.startsWith('/')) b = '/' + b;
  if (b.length > 1 && b.endsWith('/')) b = b.slice(0, -1);
  return b;
}

const home = ENV.WEB_PI_HOME;

// Controlled pi config. `pi/` in the repo is the versioned template
// (settings.json, mcp.json, skills/, extensions/, …); the runtime agent dir
// below is what spawned pi actually uses (PI_CODING_AGENT_DIR) — seeded
// from the template at boot, so sessions never read or write ~/.pi/agent.
// NB: PI_CODING_AGENT_DIR in the *server's* environment is deliberately NOT
// a fallback — on an operator's box that's their real agent dir, and seeding
// it would overwrite their config.
const agentDir = ENV.WEB_PI_AGENT_DIR;
if (PI_AGENT_DIR && !RAW_ENV.WEB_PI_AGENT_DIR) {
  bootLog.warn(`PI_CODING_AGENT_DIR is set (${PI_AGENT_DIR}) — ignoring it; ` +
    `web-pi uses its own runtime agent dir (${agentDir}). Set WEB_PI_AGENT_DIR to move it.`);
}
const agentTemplate = path.join(APP_ROOT, 'pi');

const CFG: ServerConfig = {
  host: ENV.WEB_PI_HOST,
  port: ENV.WEB_PI_PORT,
  base: normalizeBase(ENV.WEB_PI_BASE),
  home,
  agentDir,
  dbFile: ENV.WEB_PI_DB_FILE,
  clientDir: ENV.WEB_PI_CLIENT_DIR,
  astroEntry: ENV.WEB_PI_ASTRO_ENTRY,
  newSessionCwd: ENV.WEB_PI_NEW_SESSION_CWD,
  jobLogDir: ENV.WEB_PI_JOB_LOG_DIR,
  // whitespace-split command line a new terminal tab runs (plan §4;
  // default a login shell — src/lib/env.ts)
  command: ENV.WEB_PI_COMMAND.trim().split(/\s+/).filter(Boolean),
  trustProxy: Math.max(0, ENV.WEB_PI_TRUST_PROXY),
  editorUpstream: readEditorUpstream(),
};

// task/mgmt-page (docs/management-page.md §3.2): what THIS boot serves —
// the release the serving pointer file names (on the releases volume;
// serving/display state only, NEVER the enforcement's diff base — that is
// always the image's baked version.json sha, docs §1.2/§1.5 #6; also
// deliberately not the state db, which must keep opening lazily — db.ts),
// when a valid one exists, else the image copy. Resolved once, before the
// Astro entry import or any asset is served: the running process never
// changes its mind mid-flight; a release becomes served only by the
// restart below. An invalid/missing release falls back to the image —
// loudly.
const SERVING = resolveServingDirs({
  imageClientDir: CFG.clientDir,
  imageAstroEntry: CFG.astroEntry,
  releasesDir: RELEASES_DIR,
});
const IMAGE_ASTRO_ENTRY = CFG.astroEntry; // the fallback below needs the pre-swap value
const IMAGE_CLIENT_DIR = CFG.clientDir;
CFG.clientDir = SERVING.dirs.clientDir;
CFG.astroEntry = SERVING.dirs.astroEntry;
if (SERVING.note !== 'serving the image copy') console.warn(`web-pi management: ${SERVING.note}`);
// task/mgmt-page: what this process serves, LIVE — the boot snapshot, and
// the import fallback below flips it to the image copy when a release's
// SSR entry fails to load (the "serving now" card reports the truth).
let servingNow: { kind: 'image' | 'release'; sha: string | null } =
  { kind: SERVING.dirs.releaseDir === null ? 'image' : 'release', sha: SERVING.dirs.sha };

// task/mgmt-page: the swap's restart. No docker socket exists anywhere in
// webpi (it would be root on the host); instead the process exits through
// its own graceful shutdown path and the container's restart policy (or a
// host install's supervisor) brings it back on the new release. The delay
// lets the activate response reach the browser first; shutdown() guards
// re-entry itself.
const RESTART_DELAY_MS = 1500;
let mgmtRestartTimer: ReturnType<typeof setTimeout> | null = null;
const requestRestart = (): void => {
  if (mgmtRestartTimer) return;
  mgmtRestartTimer = setTimeout(() => {
    mgmtRestartTimer = null;
    shutdown('management-activate');
  }, RESTART_DELAY_MS);
};

/** Seed the runtime agent dir from the versioned template, only where the
 *  runtime dir doesn't already have the file: existing files always win, so
 *  config pi itself writes (settings.json) or the operator customises is
 *  never clobbered — the template is first-boot defaults, and template files
 *  added by upgrades still land. State only pi writes (auth.json, sessions/,
 *  caches, …) is never in the template and is left alone. */
function seedAgentDir(): void {
  try {
    fs.mkdirSync(CFG.agentDir, { recursive: true });
    if (!fs.existsSync(agentTemplate)) return;
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    for (const src of walk(agentTemplate)) {
      const dst = path.join(CFG.agentDir, path.relative(agentTemplate, src));
      if (fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst);
    }
  } catch (err) {
    bootLog.warn(`could not seed pi agent dir (${CFG.agentDir}): ${(err as Error).message}`);
  }
}
// Privilege split (DESIGN_REVIEW §1.1): with an absolute-path
// WEB_PI_TMUX_SOCKET the tmux server — and every pi session — runs as
// ANOTHER uid (the workspace half). The runtime agent dir belongs to
// that uid, so seeding happens workspace-side at its boot
// (docker-workspace-entrypoint.sh): web-side cp's would leave node-owned
// 0644 files pi can't write next to its config. Single-user shapes
// (relative socket name) keep seeding here.
if (tmux.forksServer(tmux.SOCKET)) seedAgentDir();
else bootLog.info(`privilege split: tmux socket ${tmux.SOCKET} is an absolute path — ` +
  `pi agent dir seeding and tmux server ownership live on the workspace side`);

// Environment for processes spawned inside tmux sessions (pi). Delivered
// per-session via `tmux new-session -e` — deterministic no matter when the
// tmux server (and its inherited env) was started — and set on the tmux
// client calls too, so a freshly started server inherits the same values.
const sessionEnv: Record<string, string> = {
  HOME: CFG.home,
  PI_CODING_AGENT_DIR: CFG.agentDir,
};
if (PI_SESSION_DIR) {
  sessionEnv.PI_CODING_AGENT_SESSION_DIR = PI_SESSION_DIR;
}

/** Route path under the configured base ('/login' → '/foo/login'). */
const route = (p: string): string => (CFG.base === '/' ? p : CFG.base + p);

// web-pi's own persisted state: one sqlite db (login credential, login
// sessions, the apps/workspaces/terminals tree, jobs) at CFG.dbFile,
// opened lazily on first use (src/lib/db.ts).
const stateDb = new StateDb(CFG.dbFile);
const auth: AuthType = new Auth(stateDb);
// In-process job scheduler (src/lib/jobs.ts): definitions + run
// bookkeeping live in the state db; fires open tmux sessions on the app's
// socket under the same job-session conventions as interactive sessions.
const scheduler = new jobs.Scheduler(stateDb, { cwd: CFG.newSessionCwd, env: sessionEnv, logDir: CFG.jobLogDir });
scheduler.start();
// pi auto-update (src/lib/auto-update.ts): when the persisted setting is
// ON, one check shortly after boot and then daily — always within the
// declared range, never a restart. start() only arms the deferred boot
// probe: it reads the setting lazily (the state db opens lazily — see
// db.ts — so nothing db-shaped happens eagerly at boot; with the default
// OFF nothing npm-shaped is ever scheduled).
const autoUpdater = new AutoUpdater({ db: stateDb, appRoot: APP_ROOT });
autoUpdater.start();
// Object storage (src/lib/storage.ts): any S3-compatible server, or none —
// uploads then answer 503. Nothing connects until the first upload.
const objectStore = new ObjectStore(readObjectStoreConfig());
bootLog.info(objectStore.describe() === null
  ? 'object storage: not configured (WEB_PI_S3_ENDPOINT unset) — uploads answer 503'
  : `object storage: ${objectStore.describe()}`);
bootLog.info(CFG.editorUpstream === null
  ? 'editor: not configured (WEB_PI_EDITOR_UPSTREAM unset) — /editor answers 404'
  : `editor: proxying ${CFG.base === '/' ? '' : CFG.base}/editor/ → ${CFG.editorUpstream.origin}`);
// task/ws-terminal (plan §4): a terminal tab's spawn/respawn — one
// guarded new-session with the configured command + sessionEnv, shared
// by the workspaces domain (through createServices) and the WS attach
// path's respawn.
const spawnTerminalSession = (name: TmuxSessionName, cwd: string) =>
  tmux.newSession(name, cwd, CFG.command, sessionEnv);

// Everything stateful the Astro side (API routes, pages) may use, built
// once here and passed to the Astro handler in locals — never imported
// there (a Vite-bundled second copy would carry its own state; see
// src/lib/services.ts).
const services = createServices({ cfg: CFG, stateDb, auth, scheduler, autoUpdater, objectStore,
  // task/ws-schema: the apps/workspaces domains' best-effort terminal
  // session kill (deletes/closes — src/lib/tmux.ts killSession).
  killSession: tmux.killSession,
  // task/ws-terminal (plan §4): the terminal spawn dep (see
  // spawnTerminalSession above).
  spawnSession: spawnTerminalSession,
  // task/ws-console (plan §5): /api/state's live diff source.
  liveSessionNames: tmux.liveSessionNames,
  // task/mgmt-page: the swap service's restart trigger + the honest
  // "serving now" LIVE snapshot (a getter: the import fallback above
  // flips it; docs/management-page.md §3.2).
  requestRestart, bootServing: () => servingNow });
// The scheduler's single shutdown hook. The SIGTERM/SIGINT handler is a
// sibling task (task/session-lifecycle, merged separately); at merge time
// it calls shutdownScheduler() — wired here so teardown has exactly one
// spot. Uncalled until then on purpose: the default signal exit tears the
// process (and the tick interval) down anyway.
const shutdownScheduler = (): void => scheduler.stop();
const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
const wsLimiter = new RateLimiter(Math.max(1, ENV.WEB_PI_WS_UPGRADES_PER_MIN), 60 * 1000);
// Password hashes in flight at once. Each scrypt holds 16 MiB and a libuv
// threadpool thread (4 by default, shared with fs) — past this, logins get
// 503 instead of queueing without bound.
const MAX_LOGIN_VERIFY = 4;
let loginVerifying = 0;

// ---------- helpers ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res: http.ServerResponse, code: number, body: string,
  headers?: Record<string, string>): void {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendClientFile(res: http.ServerResponse, rel: string, cache: boolean): void {
  // rel is from a fixed route table or validated against traversal below.
  const file = path.normalize(path.join(CFG.clientDir, rel));
  if (!file.startsWith(CFG.clientDir + path.sep) && file !== CFG.clientDir) {
    send(res, 404, 'not found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, 'not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-store',
    });
    res.end(data);
  });
}
/** JSON request body, capped at 10 KiB. Anything but a JSON object (array,
 *  string, null, …) is a bad request, so handlers can read fields freely. */
function readBody(req: http.IncomingMessage, cb: (err: Error | null, body?: Record<string, unknown>) => void): void {
  let n = 0; const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { n += c.length; if (n > 10240) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { cb(new Error('bad json')); return; }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) { cb(new Error('not an object')); return; }
    cb(null, body as Record<string, unknown>); // outside the try: a throwing handler must not be re-called
  });
}
/** Client IP for the rate limiters. X-Forwarded-For is client-controlled
 *  except for the entries our own proxies appended (nginx's
 *  $proxy_add_x_forwarded_for and ALB both append), so with
 *  WEB_PI_TRUST_PROXY=N the client is the Nth entry from the right — never
 *  the leftmost, which anyone can set to get a fresh bucket per request.
 *  N=0 (default): the header is ignored and the socket peer is the client. */
function ipOf(req: http.IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '?';
  if (CFG.trustProxy === 0) return peer;
  const xff = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(xff) ? xff.join(',') : xff ?? '')
    .split(',').map(h => h.trim()).filter(Boolean);
  if (hops.length === 0) return peer; // reached us without passing the proxy
  return hops[Math.max(0, hops.length - CFG.trustProxy)]!;
}
// ---------- origin check (DESIGN_REVIEW §1.2) ----------
// SameSite=Strict doesn't stop sibling subdomains (same site, not same
// origin) opening the terminal WS with the cookie attached, and no Origin
// check existed on the JSON POSTs. The expected origin is derived per
// request: Host + X-Forwarded-Proto, the latter honoured only behind a
// trusted proxy (the same right-most-untrusted-hop selection ipOf() uses
// for X-Forwarded-For — direct connections assume plain http).

/** Request scheme per WEB_PI_TRUST_PROXY: the Nth X-Forwarded-Proto entry
 *  from the right when proxies are trusted, else http. */
function protoOf(req: http.IncomingMessage): string {
  if (CFG.trustProxy === 0) return 'http';
  const xfp = req.headers['x-forwarded-proto'];
  const hops = (Array.isArray(xfp) ? xfp.join(',') : xfp ?? '')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (hops.length === 0) return 'http'; // reached us without passing the proxy
  return hops[Math.max(0, hops.length - CFG.trustProxy)]!;
}

/** Origin normalised for comparison: lowercase scheme+host, default ports
 *  (http:80, https:443) stripped — https://x:443 ≡ https://x. Origin never
 *  carries a path, so only scheme+host+port are compared (WEB_PI_BASE
 *  mounts don't affect it). Null for anything unparseable (including the
 *  literal "null" some browsers send from sandboxed frames). */
function normalizeOrigin(origin: string): string | null {
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const defPort = u.protocol === 'https:' ? ':443' : ':80';
  const host = u.host.toLowerCase();
  return `${u.protocol}//${host.endsWith(defPort) ? host.slice(0, -defPort.length) : host}`;
}

/** The origin this request may claim, from Host (+ trusted XFP). Null when
 *  there is no Host header to derive it from. */
function expectedOrigin(req: http.IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host) return null;
  const proto = protoOf(req);
  const defPort = proto === 'https' ? ':443' : ':80';
  const h = host.toLowerCase();
  return `${proto}://${h.endsWith(defPort) ? h.slice(0, -defPort.length) : h}`;
}

/** Origin gate for non-GET requests: absent Origin (curl, API clients)
 *  passes; a present Origin must match the expected origin exactly. */
function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true;
  const expected = expectedOrigin(req);
  return expected !== null && normalizeOrigin(origin) === expected;
}

// Request-body caps for everything Astro serves. The adapter's
// bodySizeLimit (astro.config.mjs) is global, so it is set to the largest
// body any route takes — an upload; every other route keeps the JSON
// API's 10 KiB here, before Astro reads a byte. A body that declares no
// length (chunked) is refused outside the upload route — browsers send a
// Content-Length for every body this app's pages post — and on it, the
// adapter's limit stops the stream mid-read.
const API_BODY_MAX_BYTES = 10 * 1024;
const UPLOAD_ROUTE = '/api/files'; // src/pages/api/files/index.ts

const isUpload = (req: http.IncomingMessage, url: string): boolean =>
  req.method === 'POST' && url === route(UPLOAD_ROUTE);

/** 413 (declared length over the route's cap), 411 (no length, off the
 *  upload route) or null (within the cap). */
function bodyCapStatus(req: http.IncomingMessage, url: string): 411 | 413 | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const upload = isUpload(req, url);
  const declared = req.headers['content-length'];
  if (declared === undefined) {
    return req.headers['transfer-encoding'] !== undefined && !upload ? 411 : null;
  }
  // Node's parser has already rejected a malformed or repeated Content-Length.
  return Number(declared) <= (upload ? UPLOAD_MAX_BODY_BYTES : API_BODY_MAX_BYTES) ? null : 413;
}

// Request-body deadlines. Node's own requestTimeout is one whole-request
// cap for every route (300 s by default) — it would cut a multi-GB upload
// off at five minutes — so it is off (by http.createServer below) and
// replaced here. Every request must still arrive whole within
// BODY_DEADLINE_MS, the same 300 s: a slow-drip body, signed in or not,
// is cut off as before (counted until the body is in, not until the
// response — a 401 sent early doesn't free a dripping socket). Only a
// signed-in upload trades the deadline for a stall timeout: no bytes for
// UPLOAD_STALL_MS and the connection goes.
const BODY_DEADLINE_MS = 300_000;
const UPLOAD_STALL_MS = 120_000;

/** Arm the whole-request deadline; the returned function disarms it. */
function armBodyDeadline(req: http.IncomingMessage): () => void {
  const { socket } = req;
  const timer = setTimeout(() => { if (!req.complete) socket.destroy(); }, BODY_DEADLINE_MS).unref();
  // Listeners come off with the timer: a keep-alive socket serves many requests.
  const disarm = (): void => { clearTimeout(timer); req.off('end', disarm); socket.off('close', disarm); };
  req.once('end', disarm);
  socket.once('close', disarm);
  return disarm;
}

/** A signed-in upload: no total deadline, but the socket must keep
 *  delivering bytes (bytesRead moving) until the body is in. Backpressure
 *  from a stalled storage server also stops the bytes — that's a stall too. */
function guardUploadStall(req: http.IncomingMessage): void {
  const { socket } = req;
  let seen = socket.bytesRead;
  let quietSince = Date.now();
  const stop = (): void => { clearInterval(check); socket.off('close', stop); };
  const check = setInterval(() => {
    if (req.complete) { stop(); return; }
    if (socket.bytesRead !== seen) { seen = socket.bytesRead; quietSince = Date.now(); return; }
    if (Date.now() - quietSince >= UPLOAD_STALL_MS) { stop(); socket.destroy(); }
  }, 10_000).unref();
  socket.once('close', stop);
}

/** Is this path inside the app's base ('/foo' and '/foo/…', or anything for '/')? */
function underBase(url: string): boolean {
  return CFG.base === '/' || url === CFG.base || url.startsWith(CFG.base + '/');
}
/** Header that clears the browser's session cookie (logout, log out everywhere). */
const clearSessionCookie = (): string =>
  `webpi_session=; HttpOnly; Secure; SameSite=Strict; Path=${CFG.base}; Max-Age=0`;

// ---------- Astro SSR (middleware) ----------
// The Astro build emits an ESM handler (dist/server/entry.mjs); loaded once
// via dynamic import (the compiled server here is CJS). Page routes render
// through it; the `next` fallback covers unknown paths (404).
type AstroHandler = (req: http.IncomingMessage, res: http.ServerResponse,
  next: (err?: unknown) => void, locals?: WebPiLocals) => void;

const astroReady: Promise<AstroHandler> =
  import(pathToFileURL(CFG.astroEntry).href)
    .then((m: { handler: AstroHandler }) => m.handler)
    // task/mgmt-page: a release's SSR entry that fails to LOAD (its own
    // imports — the one failure class no layout check can see; activate
    // probes for it, this is the belt-and-braces second line) must not
    // take the app down: fall back to the IMAGE's entry + assets, loudly,
    // and report the fallback (servingNow above feeds the page's
    // "serving now" card — the now-working page can roll back). Only the
    // image itself failing rethrows (the pre-existing behavior: every
    // render 500s).
    // task/winston-loki merge: the fallback line routes through the boot
    // logger (the operational-logging migration covers this new code).
    .catch(async (err: unknown): Promise<AstroHandler> => {
      if (CFG.astroEntry === IMAGE_ASTRO_ENTRY) throw err;
      bootLog.error(
        `web-pi management: the release's SSR entry (${CFG.astroEntry}) failed to load — falling back to the image copy, rollback from the management page: ${(err as Error)?.message ?? err}`);
      CFG.astroEntry = IMAGE_ASTRO_ENTRY;
      CFG.clientDir = IMAGE_CLIENT_DIR;
      servingNow = { kind: 'image', sha: null };
      return (await import(pathToFileURL(IMAGE_ASTRO_ENTRY).href) as { handler: AstroHandler }).handler;
    });
astroReady.catch(err => bootLog.error(
  `astro SSR entry failed to load (${CFG.astroEntry}) — did 'npm run build' run?): ${(err as Error)?.message ?? err}`));

/** Render through Astro. `locals` (the services + the request's session
 *  token) only on the authenticated path — src/middleware.ts fails closed
 *  for the API and partials without them. */
function renderAstro(req: http.IncomingMessage, res: http.ServerResponse, locals?: WebPiLocals): void {
  astroReady
    .then(handler => handler(req, res, () => send(res, 404, 'not found'), locals))
    .catch(err => { httpLog.error('astro handler error', { error: err }); send(res, 500, 'render failed'); });
}

// ---------- security headers (DESIGN_REVIEW §1.2) ----------
// Sent by the app itself on every response — host installs (no nginx) and
// container installs get the same posture. Astro pages bundle their
// scripts as external modules (script-src 'self', no 'unsafe-inline');
// xterm and Lit inject <style> at runtime, hence style 'unsafe-inline';
// the terminal WS is same-origin (ws/wss of the page's origin — 'self'
// covers both in current browsers, wss: is listed for older Safari).
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' wss:; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/** Same headers as a raw HTTP/1.1 response block (upgrade rejections are
 *  written straight to the socket — there is no ServerResponse). */
function securityHeaderBlock(): string {
  return Object.entries(SECURITY_HEADERS).map(([n, v]) => `${n}: ${v}\r\n`).join('');
}

/** Arm `res` so the security headers ride on every response the process
 *  sends, whichever path writes it: send()/sendClientFile(),
 *  the 302, and the Astro SSR handler (which calls writeHead/setHeader on
 *  the same object). Injection happens at writeHead *and* end — whichever
 *  fires first — and is idempotent, so a handler that already set one of
 *  these (or passes its own in writeHead's headers object, which wins per
 *  Node's merge rules) keeps control of it. */
function hardenResponse(res: http.ServerResponse): void {
  const apply = (): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!res.hasHeader(name)) res.setHeader(name, value);
    }
  };
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
  const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
  res.writeHead = ((...args: unknown[]) => { apply(); return writeHead(...args); }) as typeof res.writeHead;
  res.end = ((...args: unknown[]) => { apply(); return end(...args); }) as typeof res.end;
}

// ---------- editor reverse proxy (task/ws-editor, docs/editor-webapp.md) ----------
// Same-origin `${BASE}/editor/*` → WEB_PI_EDITOR_UPSTREAM (HTTP + WS),
// behind the origin check and the session gate like every other
// authenticated route — the console frames it in an iframe, so auth is
// the existing session cookie and no cross-origin anything applies.
// The decision surface (path matching, header set, body cap, tunnel
// tracking, the upgrade header pair) lives in src/lib/editor.ts; this is
// the transport.

function proxyEditorRequest(req: http.IncomingMessage, res: http.ServerResponse, upstream: EditorUpstream): void {
  // The original Host header is forwarded UNCHANGED: the editor embeds it
  // in the workbench HTML as `remoteAuthority` (spike-verified), which is
  // how the browser learns to dial its WebSocket back through this proxy.
  const headers = { ...req.headers };
  for (const hop of EDITOR_HOP_BY_HOP_HEADERS) delete headers[hop];
  const target = new URL(req.url ?? '/', upstream.origin);
  const proxied = http.request(target, { method: req.method, headers }, upstreamRes => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) out[name] = value.join(', ');
      else if (value !== undefined) out[name] = value;
    }
    for (const hop of EDITOR_HOP_BY_HOP_HEADERS) delete out[hop];
    // Editor HTML carries its own header set (framing + the VS Code web
    // CSP, pinned by the spike): handler-set headers win — hardenResponse
    // only fills absent ones. Assets keep the global set.
    if ((out['content-type'] ?? '').startsWith('text/html')) {
      for (const [name, value] of Object.entries(editorSecurityHeaders())) out[name] = value;
    }
    res.writeHead(upstreamRes.statusCode ?? 502, out);
    // STREAMED, never buffered — the workbench bundles are tens of MB.
    upstreamRes.pipe(res);
  });
  proxied.setTimeout(120_000, () => proxied.destroy(new Error('editor upstream idle')));
  proxied.on('error', err => {
    httpLog.error('editor proxy request failed', { error: err });
    if (!res.headersSent) send(res, 502, 'editor unavailable');
    else res.destroy();
  });
  req.pipe(proxied);
}

// Live editor tunnels per token: the integrated terminal makes the editor
// another shell as uid 2000, so logout / "log out everywhere" / shutdown
// must cut it within the same 30-s guarantee the terminals keep. Main.ts's
// logout paths call closeToken/closeAll; each tunnel also runs its own
// expiry sweep (below) — WS traffic never slides a token (auth.alive), so
// an idle-expired or absolutely-capped one takes its shells with it.
const editorTunnels = new EditorTunnelTracker();

/** Raw WebSocket proxy: bytes through, no frame handling, no pty — never
 *  the terminal wss/attach path. Gates (shuttingDown, Origin, session)
 *  have already run when this is called. */
function upgradeEditorSocket(req: http.IncomingMessage, socket: import('node:stream').Duplex,
  head: Buffer, token: SessionToken): void {
  const upstream = CFG.editorUpstream;
  if (!upstream) { socket.destroy(); return; } // raced a reconfigure: fail closed
  // editorUpgradeHeaders strips hop-by-hop AND re-adds the upgrade pair —
  // without Connection: Upgrade / Upgrade: websocket the upstream sees a
  // plain GET and never answers 101 (the header list alone would strip
  // them; nginx's proxy_set_header does this same dance).
  const headers = editorUpgradeHeaders(req.headers);
  const target = new URL(req.url ?? '/', upstream.origin);
  const proxied = http.request(target, { method: 'GET', headers });
  proxied.setTimeout(30_000, () => proxied.destroy(new Error('editor upstream upgrade idle')));
  proxied.on('error', err => {
    wsLog.error('editor ws upgrade failed', { error: err });
    socket.destroy();
  });
  // A plain (non-101) answer to an upgrade: forward the status, then end —
  // the browser treats anything but 101 as a failed upgrade.
  proxied.on('response', upstreamRes => {
    socket.write(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ''}\r
` +
      'Connection: close\r\n\r\n');
    socket.destroy();
  });
  proxied.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    // The upstream's handshake, verbatim (Sec-WebSocket-Accept et al).
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(upstreamRes.headers).map(([name, value]) =>
        `${name}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n') + '\r\n\r\n');
    const tunnel = {
      close(): void {
        socket.destroy();
        upstreamSocket.destroy();
      },
    };
    editorTunnels.track(token, tunnel);
    // Token-expiry sweep, the terminal keepalive's analogue: WS traffic
    // never renews a token, so an expired one ends its editor shells too.
    const sweep = setInterval(() => {
      const alive = auth.alive(token);
      if (alive.ok) return;
      if (alive.errorCode === 'no_session') editorTunnels.closeToken(token);
      // database_error: re-check next tick — never sign a shell out over a
      // db hiccup (the terminal keepalive takes the same stance).
    }, PING_INTERVAL_MS).unref();
    const done = (): void => {
      clearInterval(sweep);
      editorTunnels.untrack(token, tunnel);
      tunnel.close(); // one side ended: end the other
    };
    socket.on('close', done);
    upstreamSocket.on('close', done);
    socket.on('error', done);
    upstreamSocket.on('error', done);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    wsLog.debug('editor ws tunnel established');
  });
  proxied.end();
}

// ---------- HTTP ----------
// One access-log line per request at the node-server level: method, path,
// status, duration — emitted on 'finish', so a request is logged once,
// after the response is out. WS upgrades bypass this (no response); the
// ws connect/attach/close lines below cover them. The 15 s /api/state
// poll every open tab runs, plus hashed-asset/PWA hits, log at debug —
// silent on the console transport (level http) but pushed to loki, where
// volume is cheap; everything else is an `http`-level line.
const quietAccessPath = (p: string): boolean =>
  p === route('/api/state') || p.startsWith(route('/_astro/')) || p === route('/sw.js')
  || p === route('/manifest.webmanifest') || p.startsWith(route('/icons/'))
  // an IDE's worth of asset traffic at http level would bury the console
  || p.startsWith(route('/editor/'));

function logAccess(req: http.IncomingMessage, res: http.ServerResponse): void {
  const start = Date.now();
  res.on('finish', () => {
    const p = (req.url ?? '').split('?')[0] ?? '';
    const line = `${req.method} ${p} ${res.statusCode} in ${Date.now() - start}ms`;
    if (quietAccessPath(p)) httpLog.debug(line);
    else httpLog.http(line);
  });
}

// Last-resort guard: a synchronous throw in a route must cost one 500, not
// the process (and, in the container, every tmux session with it). Inputs
// are validated in the routes; this only catches what slips through.
const server = http.createServer((req, res) => {
  hardenResponse(res);
  logAccess(req, res);
  try { handle(req, res); }
  catch (err) {
    httpLog.error('request handler error', { error: err });
    if (!res.headersSent) send(res, 500, 'internal error'); else res.destroy();
  }
});
// Off: armBodyDeadline()/guardUploadStall() replace it per request.
// (headersTimeout — 60 s to send the headers — stays Node's.)
server.requestTimeout = 0;

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? '').split('?')[0]!;
  const disarmBodyDeadline = armBodyDeadline(req);

  // Every non-GET must be same-origin when it claims any origin at all
  // (curl & co send no Origin header and pass). Checked before routing —
  // a mismatched Origin must not touch the login limiter or anything else.
  if (req.method !== 'GET' && !originOk(req)) {
    send(res, 403, 'cross-origin request rejected');
    return;
  }

  if (req.method === 'POST' && url === route('/login')) {
    const ip = ipOf(req);
    if (!loginLimiter.allow(ip)) {
      authLog.warn('login rate-limited (10 per 15 min per IP)', { ip });
      send(res, 429, 'too many attempts');
      return;
    }
    readBody(req, (err, body) => {
      if (err) { send(res, 400, 'bad request'); return; }
      const parsed = loginBody.safeParse(body);
      if (!parsed.success) {
        authLog.info('login failed: invalid credentials (malformed body)', { ip });
        send(res, 401, 'invalid credentials'); // nginx logs it; fail2ban watches
        return;
      }
      const { username, password } = parsed.data;
      if (loginVerifying >= MAX_LOGIN_VERIFY) {
        authLog.warn('login deferred: scrypt queue full (503)', { ip });
        send(res, 503, 'busy, try again', { 'Retry-After': '1' });
        return;
      }
      loginVerifying++;
      auth.verify(username, password)
        .then(verified => {
          if (!verified.ok) {
            switch (verified.errorCode) {
              case 'invalid_credentials':
                authLog.info('login failed: invalid credentials', { username, ip });
                send(res, 401, 'invalid credentials');
                return;
              // Not a 401: fail2ban counts those, and a db hiccup is no
              // failed login. The login page reads 503 as "try again".
              case 'database_error':
                authLog.error(`login verify db error: ${verified.errorMessage}`);
                send(res, 503, 'busy, try again', { 'Retry-After': '1' });
                return;
              default: verified satisfies never; return;
            }
          }
          const session = auth.newSession();
          if (!session.ok) {
            authLog.error(`could not persist login session: ${session.errorMessage}`);
            send(res, 500, 'internal error');
            return;
          }
          authLog.info('login ok', { username, ip });
          send(res, 200, 'ok', { 'Set-Cookie': auth.cookieHeader(session.data.token, CFG.base) });
        })
        .catch(e => {
          authLog.error('login verify failed', { error: e });
          send(res, 500, 'internal error');
        })
        .finally(() => { loginVerifying--; });
    });
    return;
  }

  if (req.method === 'POST' && url === route('/logout')) {
    const token = Auth.sessionToken(req.headers.cookie);
    const dropped = auth.drop(token);
    // Logout must end the terminals AND the editor shells this token
    // authenticated, not just future requests: they get 'signed-out' and
    // don't reconnect.
    if (token) {
      closeTokenSockets(token, { type: 'signed-out' });
      editorTunnels.closeToken(token);
    }
    // A failed delete means the token is still valid server-side: say so
    // (the browser's cookie is cleared either way).
    if (!dropped.ok) {
      authLog.error(`logout failed: ${dropped.errorMessage}`);
      send(res, 500, 'could not end the session', { 'Set-Cookie': clearSessionCookie() });
      return;
    }
    authLog.info('logout');
    send(res, 200, 'ok', { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  // PWA files from public/ (service worker, manifest, icons): served with
  // or without a session — the login page links the manifest and registers
  // the worker before any auth can exist, and none of them carry data.
  if (req.method === 'GET' && url.startsWith(CFG.base)) {
    const rel = url.slice(CFG.base.length).replace(/^\//, '');
    if (rel === 'sw.js' || rel === 'manifest.webmanifest' || rel.startsWith('icons/')) {
      sendClientFile(res, '/' + rel, rel.startsWith('icons/'));
      return;
    }
  }

  // Everything below requires a valid session...
  const session = auth.valid(Auth.sessionToken(req.headers.cookie));
  if (!session.ok) {
    // ...except the PWA offline shell (static, session-free — the service
    // worker precaches it at install time, pre-auth), the hashed assets,
    // and the login page itself. Every data/terminal route stays 401.
    if (req.method === 'GET' && url === route('/offline')) {
      renderAstro(req, res);
      return;
    }
    if (req.method === 'GET' && url.startsWith(route('/_astro/'))) {
      sendClientFile(res, url.slice(CFG.base.length), true);
      return;
    }
    switch (session.errorCode) {
      case 'no_session': break;
      // Unreadable session store: fail closed, but don't claim the
      // session ended — no login page, no 401 (the console would bounce
      // to /login and a terminal would read it as signed out).
      case 'database_error':
        authLog.error(`session store unavailable: ${session.errorMessage}`);
        send(res, 503, 'session store unavailable, try again', { 'Retry-After': '5' });
        return;
      default: session satisfies never;
    }
    // Any other page GET under the base (/, /jobs, /settings, a typo'd
    // path, …) renders the login page in place — the address bar keeps
    // the URL, so signing in reloads straight into the page that was asked
    // for. No per-page allowlist to forget when a page is added. Data
    // routes are never pages: the API, the server-rendered partials
    // (fragments an element swaps in) and the proxied editor answer 401
    // instead.
    if (req.method === 'GET' && underBase(url)
      && !url.startsWith(route('/api/')) && !url.startsWith(route('/partials/'))
      && !isEditorHttpPath(CFG.base, url)) {
      req.url = route('/login');
      renderAstro(req, res);
      return;
    }
    send(res, 401, 'unauthorized');
    return;
  }

  // 'Log out everywhere' (/settings): every token dies and every
  // terminal ends — suspected-cookie-theft recovery in one click. This
  // browser's cookie is cleared too.
  if (req.method === 'POST' && url === route('/api/logout-all')) {
    const dropped = auth.dropAll();
    closeAllSockets({ type: 'signed-out' });
    editorTunnels.closeAll();
    if (!dropped.ok) {
      authLog.error(`log out everywhere failed: ${dropped.errorMessage}`);
      send(res, 500, 'could not end the sessions', { 'Set-Cookie': clearSessionCookie() });
      return;
    }
    authLog.info('log out everywhere — every session revoked');
    send(res, 200, 'ok', { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  // task/ws-editor: the same-origin editor proxy — authenticated GET/HEAD
  // streams straight through; editor bodies keep a large cap (sized to a
  // big editor save), ACCEPT length-less (chunked) bodies, and trade the
  // 5-minute whole-body deadline for the upload route's stall guard. The
  // origin check already ran at the top of handle().
  if (isEditorHttpPath(CFG.base, url)) {
    if (!CFG.editorUpstream) { send(res, 404, 'not found'); return; }
    const capped = editorBodyCapStatus(req);
    if (capped === 413) { send(res, 413, 'request body too large'); return; }
    disarmBodyDeadline();
    guardUploadStall(req);
    proxyEditorRequest(req, res, CFG.editorUpstream);
    return;
  }

  // Authenticated: hashed assets served statically; /login is pointless
  // when signed in (redirect).
  if (req.method === 'GET') {
    if (url.startsWith(route('/_astro/'))) { sendClientFile(res, url.slice(CFG.base.length), true); return; }
    if (url === route('/login')) {
      res.writeHead(302, { Location: CFG.base === '/' ? '/' : CFG.base }).end();
      return;
    }
  }

  // Everything else under the base — pages, the JSON API (src/pages/api)
  // and partials — renders through Astro, with the services and this
  // request's token in locals. The origin and session checks above have
  // already run; this is the only place locals are passed.
  if (!underBase(url)) { send(res, 404, 'not found'); return; }
  // Astro throws on an undecodable path (a bad %-escape such as
  // /api/jobs/%E0) — a client error, answered here.
  try { decodeURI(url); } catch { send(res, 400, 'bad request'); return; }
  const capped = bodyCapStatus(req, url);
  if (capped === 413) { send(res, 413, 'request body too large'); return; }
  if (capped === 411) { send(res, 411, 'request body needs a Content-Length'); return; }
  if (isUpload(req, url)) { disarmBodyDeadline(); guardUploadStall(req); }
  renderAstro(req, res, { webpi: services, session: session.data.token });
}

// ---------- WebSocket → node-pty → tmux attach ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

// Live sockets per session token, fed by the upgrade handler (which has
// already validated it): POST /logout, log-out-everywhere and shutdown
// must end the terminals a token authenticated — not merely stop future
// requests — and shutdown must be able to reach every client.
const socketsByToken = new Map<SessionToken, Set<WebSocket>>();

function trackSocket(token: SessionToken, ws: WebSocket): void {
  let set = socketsByToken.get(token);
  if (!set) { set = new Set(); socketsByToken.set(token, set); }
  set.add(ws);
}
function untrackSocket(token: SessionToken, ws: WebSocket): void {
  const set = socketsByToken.get(token);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socketsByToken.delete(token);
}

/** Close with a hard fallback: a peer that never answers the close frame
 *  (dead client, or a script holding a stolen token) is terminated — a
 *  logout/shutdown can't leave a live terminal behind on a limp socket. */
function closeSoon(ws: WebSocket): void {
  try { ws.close(); } catch { /* already closed */ }
  setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } }, 1500).unref();
}

/** Send `final`, then end every socket authenticated with `token`. */
function closeTokenSockets(token: SessionToken, final: ServerMsg): void {
  const set = socketsByToken.get(token);
  if (!set) return;
  socketsByToken.delete(token);
  for (const ws of set) { wsSend(ws, final); closeSoon(ws); }
}

/** Send `final`, then end every socket, whichever token it used. */
function closeAllSockets(final: ServerMsg): void {
  for (const set of socketsByToken.values()) {
    for (const ws of set) { wsSend(ws, final); closeSoon(ws); }
  }
  socketsByToken.clear();
}

// Graceful shutdown state (sequence at the bottom, by server.listen).
let shuttingDown = false;

server.on('upgrade', (req, socket, head) => {
  const url = (req.url ?? '').split('?')[0]!;
  // task/ws-editor: the editor's WebSockets first — a PREFIX branch before
  // the terminal's equality check: the browser dials
  // `${BASE}/editor/stable-<commit>?reconnectionToken=…` (two per window,
  // Management + ExtensionHost — spike-pinned). Same gates as the terminal
  // except the ws rate limiter: VS Code opens several sockets per window,
  // so 30/min/IP would throttle two tabs. The socket itself is a raw byte
  // tunnel to the upstream — never the terminal's wss/attach path (no pty) —
  // tracked per token so logout cuts editor shells too.
  if (isEditorUpgradePath(CFG.base, url)) {
    if (shuttingDown) { socket.destroy(); return; }
    if (!CFG.editorUpstream) {
      socket.write(`HTTP/1.1 404 Not Found\r\n${securityHeaderBlock()}\r\n`);
      socket.destroy();
      return;
    }
    // Browser-only, same as the terminal: an upgrade must carry a matching
    // Origin (the console's iframe is same-origin and always sends one).
    const ip = ipOf(req);
    const origin = req.headers.origin;
    if (!origin || !originOk(req)) {
      wsLog.warn('editor ws upgrade rejected: missing or mismatched Origin', { ip });
      socket.destroy();
      return;
    }
    const token = Auth.sessionToken(req.headers.cookie);
    const session = auth.valid(token);
    if (!session.ok) {
      let status: string;
      switch (session.errorCode) {
        case 'no_session':
          wsLog.info('editor ws upgrade rejected: no valid session', { ip });
          status = '401 Unauthorized';
          break;
        case 'database_error':
          authLog.error(`session store unavailable: ${session.errorMessage}`);
          status = '503 Service Unavailable';
          break;
        default: return session satisfies never;
      }
      socket.write(`HTTP/1.1 ${status}\r\n${securityHeaderBlock()}\r\n`);
      socket.destroy();
      return;
    }
    upgradeEditorSocket(req, socket, head, session.data.token);
    return;
  }
  if (url !== route('/ws')) { socket.destroy(); return; }
  if (shuttingDown) { socket.destroy(); return; } // stopping: no new terminals
  const ip = ipOf(req);
  if (!wsLimiter.allow(ip)) {
    wsLog.warn('ws upgrade rate-limited (30 per min per IP)', { ip });
    socket.destroy();
    return;
  }
  // The terminal is browser-only: an upgrade must carry a matching Origin
  // (no curl/websocat clients, no cross-site WebSocket hijacking from a
  // sibling subdomain). Unlike plain HTTP there is no Origin-free path —
  // a missing header is destroyed, not waved through.
  const origin = req.headers.origin;
  if (!origin || !originOk(req)) {
    wsLog.warn('ws upgrade rejected: missing or mismatched Origin', { ip });
    socket.destroy();
    return;
  }
  const token = Auth.sessionToken(req.headers.cookie);
  const session = auth.valid(token);
  if (!session.ok) {
    let status: string;
    switch (session.errorCode) {
      case 'no_session':
        wsLog.info('ws upgrade rejected: no valid session', { ip });
        status = '401 Unauthorized';
        break;
      // Fail closed without calling it signed out (same as HTTP's 503).
      case 'database_error':
        authLog.error(`session store unavailable: ${session.errorMessage}`);
        status = '503 Service Unavailable';
        break;
      default: return session satisfies never;
    }
    socket.write(`HTTP/1.1 ${status}\r\n${securityHeaderBlock()}\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => attach(ws, session.data.token));
});

interface Pty { write(d: string): void; resize(c: number, r: number): void; kill(): void;
  onData(cb: (d: string) => void): void; onExit(cb: () => void): void }

function wsSend(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// parseClientMsg (the client-frame gate) lives in src/schemas/frames.ts;
// ClientMsg (the union it yields) is re-exported by src/lib/types.ts.

// Keepalive: a ping per connection this often. Idle-timeout proxies (ALB
// defaults to 60s; nginx's proxy_read_timeout) count it as traffic, so a
// terminal sitting at pi's prompt isn't cut; a ping unanswered by the next
// tick means the peer is gone — terminate, and the pty is reaped.
const PING_INTERVAL_MS = 30_000;

function attach(ws: WebSocket, token: SessionToken): void {
  wsLog.debug('ws connected');
  trackSocket(token, ws);
  let p: Pty | null = null;
  // The tmux session this socket successfully attached to (null until
  // then): the attached/detached lifecycle pair logs at info, while the
  // socket opening itself stays at debug — a socket opens on every tab
  // load and reconnect, and most of them do attach, but a failed one
  // (no such session, the never-fork guard) shouldn't bury the console.
  let attachedTo: TmuxSessionName | null = null;
  // Attach in flight: the spawn is one async step deeper than it used to
  // be (the never-fork guard runs before the pty spawn), so a second
  // {attach} frame in that window must not start a second spawn — `!p`
  // alone can't see it yet. Cleared on the error paths so a failed attach
  // is retryable on the same socket.
  let starting = false;
  // The client sends {attach} and {resize} back-to-back on open, but the
  // pty only exists after an async tmux lookup — remember the requested
  // size and spawn at it, or the session opens at 80x24 inside a larger
  // browser terminal ("terminal not fitting on open").
  let size = { cols: 80, rows: 24 };

  async function spawnTmux(target: TmuxSessionName): Promise<void> {
    // Never-fork gate, same as the create paths: attach is a forking
    // tmux command too — on an absolute socket it must not run against a
    // missing/stale socket (that forks a server as the web uid).
    const server = await tmux.requireServer();
    if (!server.ok) { starting = false; wsSend(ws, { type: 'error', message: tmux.SERVER_NOT_RUNNING_MSG }); return; }
    const env = Object.assign({}, process.env, {
      TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME: CFG.home,
      PI_CODING_AGENT_DIR: CFG.agentDir,
    });
    let x: Pty;
    try {
      x = pty.spawn('tmux', [...tmux.socketArgs(tmux.SOCKET), 'attach', '-d', '-t', target],
        { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: CFG.newSessionCwd, env }) as Pty;
    } catch (e) {
      starting = false;
      wsSend(ws, { type: 'error', message: 'spawn failed: ' + (e as Error).message });
      return;
    }
    x.onData(d => wsSend(ws, { type: 'output', data: d }));
    x.onExit(() => { wsSend(ws, { type: 'exit', target }); ws.close(); });
    p = x;
    attachedTo = target;
    wsSend(ws, { type: 'attached', target, socket: tmux.SOCKET });
    wsLog.info('terminal attached', { target });
  }

  async function onMessage(msg: ClientMsg): Promise<void> {
    if (msg.type === 'input') {
      // Written whole: the client splits big pastes into consecutive input
      // frames (agent-terminal.ts), and maxPayload bounds any one frame.
      if (p) p.write(msg.data);
    } else if (msg.type === 'resize') {
      const c = Math.min(Math.max(Math.trunc(msg.cols) || 80, 10), 500);
      const r = Math.min(Math.max(Math.trunc(msg.rows) || 24, 4), 200);
      size = { cols: c, rows: r };
      if (p) { try { p.resize(c, r); } catch { /* race on exit */ } }
    } else if (msg.type === 'attach' && !p && !starting) {
      starting = true;
      const failed = (message: string): void => {
        starting = false;
        wsSend(ws, { type: 'error', message });
      };
      if (msg.mode === 'terminal') {
        // task/ws-terminal (plan §4/§7): the restart-survival path. The
        // id is the terminal ROW's uuid — the state db owns the identity,
        // the tmux session name is derived (t-<uuid>). tmux alive = the
        // content survives (web restart, the common case); tmux dead =
        // the structure survives and this attach RESPAWNS a fresh
        // command at the workspace cwd. The respawn rides the same
        // guarded new-session the create route uses, so the never-fork
        // guard covers it on absolute sockets.
        const id = TerminalIdSchema.safeParse(msg.id);
        if (!id.success) { failed('bad terminal id'); return; }
        const found = await services.workspaces.terminalForAttach(id.data);
        if (!found.ok) {
          failed(found.errorCode === 'database_error' ? 'could not read the terminal' : 'no such terminal');
          return;
        }
        const name = tmux.terminalSessionName(id.data);
        if (!await tmux.hasSession(name)) {
          const spawned = await spawnTerminalSession(name, found.data.cwd);
          if (!spawned.ok) {
            switch (spawned.errorCode) {
              // the never-fork guard — say it, don't bury it
              case 'server_not_running': failed(tmux.SERVER_NOT_RUNNING_MSG); return;
              case 'tmux_error': failed('could not start terminal session'); return;
              default: spawned satisfies never;
            }
            return;
          }
          wsLog.info(`terminal ${id.data} respawned (${name} at ${found.data.cwd})`);
        }
        await spawnTmux(name);
      } else if (msg.mode === 'run') {
        // task/ws-terminal (plan §7): a live job run's tmux session
        // (webpi-<name>) — the jobs view-run path. NEVER respawns: the
        // run IS the session, it dies with the command, and a re-run is a
        // new session (jobs.ts), not a respawn of a dead one.
        const target = TmuxSessionNameSchema.safeParse(msg.target);
        if (!target.success) { failed('bad target'); return; }
        if (!await tmux.hasSession(target.data)) { failed('no such run session'); return; }
        await spawnTmux(target.data);
      }
    }
  }

  ws.on('message', raw => {
    const msg = parseClientMsg(Buffer.from(raw as Buffer).toString('utf8'));
    if (!msg) return; // malformed frames are dropped, never thrown on
    onMessage(msg).catch(err => wsLog.error('ws message handler error', { error: err }));
  });

  let alive = true;
  ws.on('pong', () => { alive = true; });
  const keepalive = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    // Liveness sweep: the expiry clocks must bind established terminals
    // too. A socket whose token died — idle, the 30-day absolute cap, or
    // a logout-everywhere — gets the signed-out message and closes on
    // the next tick instead of riding the keepalive forever (a terminal
    // is a live shell; the token dying for HTTP must end it too).
    // Non-renewing on purpose (auth.alive): WS traffic never slides a
    // token — only authed HTTP does, via auth.valid.
    const live = auth.alive(token);
    if (!live.ok) {
      switch (live.errorCode) {
        case 'no_session': closeTokenSockets(token, { type: 'signed-out' }); return;
        // Unreadable session store: can't tell, so don't sign the terminal
        // out over a db hiccup — its token was alive at the last sweep;
        // re-check next tick (the peer-liveness ping below still runs).
        case 'database_error': authLog.error(`session store unavailable: ${live.errorMessage}`); break;
        default: live satisfies never;
      }
    }
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, PING_INTERVAL_MS);

  ws.on('close', () => {
    untrackSocket(token, ws);
    clearInterval(keepalive);
    if (p) { try { p.kill(); } catch { /* already gone */ } }
    // Covers both ways a terminal ends: the pty exiting (the 'exit' frame
    // above) and the peer closing the tab.
    if (attachedTo) wsLog.info('terminal detached', { target: attachedTo });
  });
  ws.on('error', () => { if (p) { try { p.kill(); } catch { /* noop */ } } });
}

server.listen(CFG.port, CFG.host, () => {
  bootLog.info(`web-pi listening on ${CFG.host}:${CFG.port} base ${CFG.base} ` +
    `(tmux socket ${tmux.SOCKET}, command "${CFG.command.join(' ')}", client ${CFG.clientDir})`);
  // Best-effort vendored-pi version at boot — makes dependency drift visible.
  if (CFG.command[0] === PI_BIN) {
    execFile(PI_BIN, ['--version'], { timeout: 5000 }, (err, out) =>
      bootLog.info(err ? `pi: version check failed (${(err as Error).message})` : `pi ${String(out).trim()}`));
  }
});

// ---------- graceful shutdown (SIGTERM / SIGINT) ----------
// Docker stop, compose, systemd — the container's init relays the signal
// and the stop must not hang (SIGKILL waits behind stopTimeout, and every
// attached terminal goes with it). The sequence: stop accepting new
// connections, tell every open WS 'restart' and close it, then exit once
// the sockets have drained. shutdownSteps is a small ordered list of
// closures — other subsystems register into it by pushing (the in-process
// scheduler stops its tick loop there, so no job fires mid-drain);
// deliberately not a framework, just "later in the array runs later".
const SHUTDOWN_DEADLINE_MS = 5000;
const whenClosed = new Promise<void>(resolve => server.once('close', resolve));
const shutdownSteps: Array<() => void | Promise<void>> = [
  () => { shutdownScheduler(); },                    // 0. stop firing scheduled jobs
  () => { autoUpdater.stop(); },                    // 0.5 stop the auto-update loop
  () => { server.close(); },                        // 1. stop listening
  () => { closeAllSockets({ type: 'restart' }); },  // 2. notify + close every client
  () => { editorTunnels.closeAll(); },              // 2.5 editor tunnels: cut (the iframe reconnects)
  () => {
    // Re-armed on an interval, not one-shot: a terminal's close makes the
    // console page re-poll /api/state on its keep-alive socket — busy
    // (not idle) at the moment of a one-shot call, then idle with nothing
    // left to close it, so the one-shot form usually lands on the
    // deadline with a misleading "drain unfinished". The sweep closes each
    // straggler the moment it goes idle, so the drain usually completes
    // clean; the deadline stays as the backstop.
    const sweep = setInterval(() => server.closeIdleConnections(), 250);
    return whenClosed.finally(() => clearInterval(sweep));
  },
  // 3. flush the logger: loki's last batch goes out (capped in closeLogger
  // itself — the deadline backstop in shutdown() stays authoritative); the
  // console transport needs no flush.
  () => closeLogger(),
];

function shutdown(signal: string): void {
  if (shuttingDown) process.exit(0); // a second signal skips the drain
  shuttingDown = true;
  shutdownLog.info(`${signal} received — shutting down`);
  // A stuck socket must not hold the stop past the deadline.
  const deadline = setTimeout(() => {
    shutdownLog.error(`shutdown: drain unfinished after ${SHUTDOWN_DEADLINE_MS}ms — exiting`);
    process.exit(0);
  }, SHUTDOWN_DEADLINE_MS);
  (async () => {
    for (const step of shutdownSteps) {
      try { await step(); } catch (err) { shutdownLog.error('shutdown step failed', { error: err }); }
    }
    clearTimeout(deadline);
    process.exit(0);
  })();
}
// on(), not once(): a repeated SAME signal would have consumed its once
// listener and taken the default exit (143) mid-drain — with on(), the
// shuttingDown flag makes every later signal the fast exit path.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
