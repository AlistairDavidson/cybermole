#!/usr/bin/env node
// cybermole server: Astro SSR, the REST API, and the WS→node-pty→tmux terminal.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import { Auth, RateLimiter, type Auth as AuthType } from '../src/lib/platform/auth';
import { StateDb } from '../src/lib/platform/db';
import * as tmux from '../src/lib/terminals/tmux';
import {
  ENV,
  RAW_ENV,
  APP_ROOT,
  PI_BIN,
  PI_AGENT_DIR,
  PI_SESSION_DIR,
  readAppsSocket,
  readInternalApiSocket,
  readObjectStoreConfig,
  readEditorUpstream,
} from '../src/lib/platform/env';
import { componentLogger, closeLogger } from '../src/lib/platform/logger';
import * as jobs from '../src/lib/jobs/jobs';
import { seedRootAgentsFile } from '../src/lib/platform/root-agents';
import { EventsRelay, checkEventsUpgrade } from '../src/lib/platform/events-ws';
import { AutoUpdater } from '../src/lib/platform/auto-update';
import {
  EDITOR_HOP_BY_HOP_HEADERS,
  EDITOR_HTML_REWRITE_MAX_BYTES,
  EditorTunnelTracker,
  editorBodyCapStatus,
  editorSecurityHeaders,
  editorUpgradeHeaders,
  injectWorkbenchThemeDefaults,
  isEditorHttpPath,
  isEditorUpgradePath,
  type EditorUpstream,
} from '../src/lib/terminals/editor';
import {
  createServices,
  type ServerConfig,
  type CybermoleLocals,
} from '../src/lib/platform/services';
import { handleAppsRequest, isAppsHttpPath } from '../src/lib/apps/apps-proxy';
import { AppsServing } from '../src/lib/apps/apps-serving';
import {
  startAppHostSupervisor,
  type AppHostSupervisorHandle,
} from '../src/lib/apps/app-host-supervisor';
import { grafanaExploreUrlFromEnv } from '../src/lib/platform/grafana';
import {
  resolvedAgentCommand,
  resolvedShellCommand,
  splitCommandLine,
} from '../src/lib/terminals/terminal-defaults';
import { startInternalApi, InternalSocketOwnedError, type InternalApiHandle } from './internal-api';
import { ObjectStore } from '../src/lib/platform/storage';
import type { ClientMsg, ServerMsg } from '../src/lib/platform/types';
import { loginBody } from '../src/schemas/api';
import { parseClientMsg } from '../src/schemas/frames';
import {
  TerminalIdSchema,
  TmuxSessionNameSchema,
  type SessionToken,
  type TmuxSessionName,
} from '@cybermole/app-kit';
import { UPLOAD_MAX_BODY_BYTES } from '../src/schemas/uploads';

// set-password.ts keeps plain console.* — it's CLI output, not server logs.
const bootLog = componentLogger('boot');
const httpLog = componentLogger('http');
const authLog = componentLogger('auth');
const wsLog = componentLogger('ws');
const shutdownLog = componentLogger('shutdown');

// '/' or '/foo', no trailing slash. Must match the base astro.config.mjs built with.
function normalizeBase(raw: string): string {
  let b = (raw || '/').trim();
  if (!b.startsWith('/')) b = '/' + b;
  if (b.length > 1 && b.endsWith('/')) b = b.slice(0, -1);
  return b;
}

const home = ENV.CYBERMOLE_HOME;

// The server's own PI_CODING_AGENT_DIR is deliberately not a fallback: on an
// operator's box that's their real agent dir, and seeding would clobber it.
const agentDir = ENV.CYBERMOLE_AGENT_DIR;
if (PI_AGENT_DIR && !RAW_ENV.CYBERMOLE_AGENT_DIR) {
  bootLog.warn(
    `PI_CODING_AGENT_DIR is set (${PI_AGENT_DIR}) — ignoring it; ` +
      `cybermole uses its own runtime agent dir (${agentDir}). Set CYBERMOLE_AGENT_DIR to move it.`,
  );
}
const agentTemplate = path.join(APP_ROOT, 'runtime', 'pi-agent-dir');
const rootAgentsTemplate = path.join(APP_ROOT, 'runtime', 'workspace-root', 'AGENTS.md');

const CFG: ServerConfig = {
  host: ENV.CYBERMOLE_HOST,
  port: ENV.CYBERMOLE_PORT,
  base: normalizeBase(ENV.CYBERMOLE_BASE),
  home,
  agentDir,
  dbFile: ENV.CYBERMOLE_DB_FILE,
  clientDir: ENV.CYBERMOLE_CLIENT_DIR,
  astroEntry: ENV.CYBERMOLE_ASTRO_ENTRY,
  newSessionCwd: ENV.CYBERMOLE_NEW_SESSION_CWD,
  jobLogDir: ENV.CYBERMOLE_JOB_LOG_DIR,
  // Terminal commands resolve per spawn (terminal-defaults.ts) so /settings applies without a restart.
  trustProxy: Math.max(0, ENV.CYBERMOLE_TRUST_PROXY),
  editorUpstream: readEditorUpstream(),
  grafanaExploreUrl: grafanaExploreUrlFromEnv(),
};

/** Copy template files into the runtime agent dir where absent. Existing
 *  files always win, so pi's own writes and operator edits survive. */
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
function seedRootAgents(): void {
  const seeded = seedRootAgentsFile(CFG.newSessionCwd, rootAgentsTemplate);
  if (seeded.ok) {
    if (seeded.data.seeded)
      bootLog.info(
        `workspace root: seeded AGENTS.md at ${seeded.data.target} ` +
          "(the root agent's standing instructions — only where absent)",
      );
    return;
  }
  bootLog.warn(`could not seed the workspace-root AGENTS.md: ${seeded.errorMessage}`);
}
// With an absolute tmux socket, pi runs as the workspace uid, which owns the
// agent dir; seeding happens workspace-side (docker-workspace-entrypoint.sh)
// so files aren't left owned by this uid.
if (tmux.forksServer(tmux.SOCKET)) {
  seedAgentDir();
  seedRootAgents();
} else
  bootLog.info(
    `privilege split: tmux socket ${tmux.SOCKET} is an absolute path — ` +
      `pi agent dir and workspace-root AGENTS.md seeding, and tmux server ` +
      `ownership, live on the workspace side`,
  );

// Env for processes inside tmux sessions, passed per session (`new-session -e`)
// so it doesn't depend on what env the tmux server started with.
const sessionEnv: Record<string, string> = {
  HOME: CFG.home,
  PI_CODING_AGENT_DIR: CFG.agentDir,
};
if (PI_SESSION_DIR) {
  sessionEnv.PI_CODING_AGENT_SESSION_DIR = PI_SESSION_DIR;
}

/** Route path under the configured base ('/login' → '/foo/login'). */
const route = (p: string): string => (CFG.base === '/' ? p : CFG.base + p);

const stateDb = new StateDb(CFG.dbFile);
const auth: AuthType = new Auth(stateDb);
const scheduler = new jobs.Scheduler(stateDb, {
  cwd: CFG.newSessionCwd,
  env: sessionEnv,
  logDir: CFG.jobLogDir,
  logMaxBytes: ENV.CYBERMOLE_JOB_LOG_MAX,
});
scheduler.start();
// Reads its setting lazily: the state db opens lazily, and with auto-update
// off nothing is ever scheduled.
const autoUpdater = new AutoUpdater({ db: stateDb, appRoot: APP_ROOT });
autoUpdater.start();
// Nothing connects until the first upload; unconfigured, uploads answer 503.
const objectStore = new ObjectStore(readObjectStoreConfig());
bootLog.info(
  objectStore.describe() === null
    ? 'object storage: not configured (CYBERMOLE_S3_ENDPOINT unset) — uploads answer 503'
    : `object storage: ${objectStore.describe()}`,
);
bootLog.info(
  CFG.editorUpstream === null
    ? 'editor: not configured (CYBERMOLE_EDITOR_UPSTREAM unset) — /editor answers 404'
    : `editor: proxying ${CFG.base === '/' ? '' : CFG.base}/editor/ → ${CFG.editorUpstream.origin}`,
);
bootLog.info(
  CFG.grafanaExploreUrl === null
    ? 'logs: not configured (CYBERMOLE_GRAFANA_URL unset) — /logs answers 404'
    : `logs: framing Grafana Explore (${CFG.grafanaExploreUrl})`,
);

// ---------- apps surface ----------
// CYBERMOLE_APPS_SOCK unset: this server spawns and supervises the app host.
// Set: someone else owns the host and this is only a client. Empty: apps off.
const APPS_SOCK = readAppsSocket();
let appHostSupervisor: AppHostSupervisorHandle | null = null;
if (APPS_SOCK === null) {
  bootLog.info('apps: off (CYBERMOLE_APPS_SOCK is empty) — /apps/* answers 404');
} else if (RAW_ENV.CYBERMOLE_APPS_SOCK !== undefined) {
  bootLog.info(
    `apps: client-only on ${APPS_SOCK} (CYBERMOLE_APPS_SOCK set — the ` +
      'workspace-side entrypoint or operator owns the app host process)',
  );
} else {
  appHostSupervisor = startAppHostSupervisor({
    command: process.execPath,
    args: [path.join(APP_ROOT, 'dist-server', 'server', 'app-host.js')],
    env: process.env,
    log: componentLogger('app-host'),
  });
  bootLog.info(
    `apps: single-user shape — spawning + supervising the app host (default socket ${APPS_SOCK})`,
  );
}
const appsServing = new AppsServing({ socketPath: APPS_SOCK });
const spawnTerminalSession = (name: TmuxSessionName, cwd: string, command: string[]) =>
  tmux.newSession(name, cwd, command, sessionEnv);

// Built once here and handed to Astro via locals, never imported there: a
// Vite-bundled second copy would carry its own state.
const services = createServices({
  cfg: CFG,
  stateDb,
  auth,
  scheduler,
  autoUpdater,
  objectStore,
  killSession: tmux.killSession,
  spawnSession: spawnTerminalSession,
  liveSessionNames: tmux.liveSessionNames,
  appsServing,
});
const shutdownScheduler = (): void => scheduler.stop();

// ---------- internal API ----------
// Unix-socket listener serving the workspace side (agents) the jobs/apps
// services, gated by the socket's file mode instead of cookies. If another
// live instance owns the socket, keep serving without it rather than die.
const INTERNAL_SOCK = readInternalApiSocket();
let internalApi: InternalApiHandle | null = null;
if (INTERNAL_SOCK === null) {
  bootLog.info(
    'internal API: off (CYBERMOLE_SOCK is empty) — the workspace side has no jobs socket',
  );
} else {
  startInternalApi({ socketPath: INTERNAL_SOCK, scheduler, apps: services.apps })
    .then(api => {
      internalApi = api;
    })
    .catch(err => {
      if (err instanceof InternalSocketOwnedError) {
        bootLog.error(
          `internal API DISABLED on this instance: ${err.message} — ` +
            "the workspace side's jobs tools (CLI/MCP) will fail until this instance owns the socket",
        );
        return;
      }
      bootLog.error(`internal API failed to start on ${INTERNAL_SOCK}: ${(err as Error).message}`);
      process.exit(1);
    });
}
const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
const wsLimiter = new RateLimiter(Math.max(1, ENV.CYBERMOLE_WS_UPGRADES_PER_MIN), 60 * 1000);
// Concurrent scrypt verifies (16 MiB + a libuv thread each); past this, 503.
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

function send(
  res: http.ServerResponse,
  code: number,
  body: string,
  headers?: Record<string, string>,
): void {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendClientFile(res: http.ServerResponse, rel: string, cache: boolean): void {
  const file = path.normalize(path.join(CFG.clientDir, rel));
  if (!file.startsWith(CFG.clientDir + path.sep) && file !== CFG.clientDir) {
    send(res, 404, 'not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, 'not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-store',
    });
    res.end(data);
  });
}
/** JSON request body, capped at 10 KiB. Anything but a JSON object (array,
 *  string, null, …) is a bad request, so handlers can read fields freely. */
function readBody(
  req: http.IncomingMessage,
  cb: (err: Error | null, body?: Record<string, unknown>) => void,
): void {
  let n = 0;
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => {
    n += c.length;
    if (n > 10240) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      cb(new Error('bad json'));
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      cb(new Error('not an object'));
      return;
    }
    cb(null, body as Record<string, unknown>); // outside the try: a throwing cb must not be re-called
  });
}
/** Client IP for the rate limiters. With CYBERMOLE_TRUST_PROXY=N it's the Nth
 *  X-Forwarded-For entry from the right; the leftmost is client-controlled. */
function ipOf(req: http.IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '?';
  if (CFG.trustProxy === 0) return peer;
  const xff = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
    .split(',')
    .map(h => h.trim())
    .filter(Boolean);
  if (hops.length === 0) return peer; // reached us without passing the proxy
  return hops[Math.max(0, hops.length - CFG.trustProxy)]!;
}
// ---------- origin check ----------
// SameSite=Strict doesn't stop sibling subdomains (same site, different
// origin), so non-GETs and WS upgrades check Origin against Host + trusted XFP.

function protoOf(req: http.IncomingMessage): string {
  if (CFG.trustProxy === 0) return 'http';
  const xfp = req.headers['x-forwarded-proto'];
  const hops = (Array.isArray(xfp) ? xfp.join(',') : (xfp ?? ''))
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
  if (hops.length === 0) return 'http'; // reached us without passing the proxy
  return hops[Math.max(0, hops.length - CFG.trustProxy)]!;
}

/** Lowercased scheme+host with default ports stripped; null if unparseable
 *  (including the literal "null" sandboxed frames send). */
function normalizeOrigin(origin: string): string | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const defPort = u.protocol === 'https:' ? ':443' : ':80';
  const host = u.host.toLowerCase();
  return `${u.protocol}//${host.endsWith(defPort) ? host.slice(0, -defPort.length) : host}`;
}

function expectedOrigin(req: http.IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host) return null;
  const proto = protoOf(req);
  const defPort = proto === 'https' ? ':443' : ':80';
  const h = host.toLowerCase();
  return `${proto}://${h.endsWith(defPort) ? h.slice(0, -defPort.length) : h}`;
}

/** Absent Origin (curl, API clients) passes; a present one must match. */
function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true;
  const expected = expectedOrigin(req);
  return expected !== null && normalizeOrigin(origin) === expected;
}

// The adapter's bodySizeLimit is global, so it's set for uploads; every other
// route is capped at 10 KiB here. Chunked bodies are refused off the upload route.
const API_BODY_MAX_BYTES = 10 * 1024;
const UPLOAD_ROUTE = '/api/files';

const isUpload = (req: http.IncomingMessage, url: string): boolean =>
  req.method === 'POST' && url === route(UPLOAD_ROUTE);

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

// Node's requestTimeout would cut long uploads, so it's off and replaced:
// every body must arrive within BODY_DEADLINE_MS, except a signed-in upload,
// which instead dies after UPLOAD_STALL_MS without bytes.
const BODY_DEADLINE_MS = 300_000;
const UPLOAD_STALL_MS = 120_000;

function armBodyDeadline(req: http.IncomingMessage): () => void {
  const { socket } = req;
  const timer = setTimeout(() => {
    if (!req.complete) socket.destroy();
  }, BODY_DEADLINE_MS).unref();
  // Keep-alive sockets serve many requests: detach listeners with the timer.
  const disarm = (): void => {
    clearTimeout(timer);
    req.off('end', disarm);
    socket.off('close', disarm);
  };
  req.once('end', disarm);
  socket.once('close', disarm);
  return disarm;
}

/** Backpressure from a stalled storage server stops bytes too — that counts as a stall. */
function guardUploadStall(req: http.IncomingMessage): void {
  const { socket } = req;
  let seen = socket.bytesRead;
  let quietSince = Date.now();
  const stop = (): void => {
    clearInterval(check);
    socket.off('close', stop);
  };
  const check = setInterval(() => {
    if (req.complete) {
      stop();
      return;
    }
    if (socket.bytesRead !== seen) {
      seen = socket.bytesRead;
      quietSince = Date.now();
      return;
    }
    if (Date.now() - quietSince >= UPLOAD_STALL_MS) {
      stop();
      socket.destroy();
    }
  }, 10_000).unref();
  socket.once('close', stop);
}

function underBase(url: string): boolean {
  return CFG.base === '/' || url === CFG.base || url.startsWith(CFG.base + '/');
}
const clearSessionCookie = (): string =>
  `cybermole_session=; HttpOnly; Secure; SameSite=Strict; Path=${CFG.base}; Max-Age=0`;

// ---------- Astro SSR (middleware) ----------
// dist/server/entry.mjs is ESM; this server compiles to CJS, hence the dynamic import.
type AstroHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (err?: unknown) => void,
  locals?: CybermoleLocals,
) => void;

const astroReady: Promise<AstroHandler> = import(pathToFileURL(CFG.astroEntry).href).then(
  (m: { handler: AstroHandler }) => m.handler,
);
astroReady.catch(err =>
  bootLog.error(
    `astro SSR entry failed to load (${CFG.astroEntry}) — did 'npm run build' run?): ${(err as Error)?.message ?? err}`,
  ),
);

/** locals only on the authenticated path; middleware.ts fails closed without them. */
function renderAstro(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  locals?: CybermoleLocals,
): void {
  astroReady
    .then(handler => handler(req, res, () => send(res, 404, 'not found'), locals))
    .catch(err => {
      httpLog.error('astro handler error', { error: err });
      send(res, 500, 'render failed');
    });
}

// ---------- security headers ----------
// xterm and Lit inject <style> at runtime, hence 'unsafe-inline' styles;
// wss: is for older Safari, where 'self' doesn't cover it.
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' wss:; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/** For upgrade rejections, written straight to the socket. */
function securityHeaderBlock(): string {
  return Object.entries(SECURITY_HEADERS)
    .map(([n, v]) => `${n}: ${v}\r\n`)
    .join('');
}

/** Apply the security headers on writeHead or end, whichever comes first,
 *  without overriding any a handler set itself. */
function hardenResponse(res: http.ServerResponse): void {
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

// ---------- editor reverse proxy ----------
// ${BASE}/editor/* → CYBERMOLE_EDITOR_UPSTREAM (HTTP + WS), behind the usual
// session gate. Decisions live in src/lib/terminals/editor.ts.

function proxyEditorRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: EditorUpstream,
): void {
  // Host is forwarded unchanged: the editor embeds it as `remoteAuthority`,
  // which is how the browser finds its WebSocket back through this proxy.
  const headers = { ...req.headers };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- scrubbing the hop-by-hop header set
  for (const hop of EDITOR_HOP_BY_HOP_HEADERS) delete headers[hop];
  const target = new URL(req.url ?? '/', upstream.origin);
  const proxied = http.request(target, { method: req.method, headers }, upstreamRes => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) out[name] = value.join(', ');
      else if (value !== undefined) out[name] = value;
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- scrubbing the hop-by-hop header set
    for (const hop of EDITOR_HOP_BY_HOP_HEADERS) delete out[hop];
    // Editor HTML gets its own header set (framing + VS Code CSP).
    if ((out['content-type'] ?? '').startsWith('text/html')) {
      for (const [name, value] of Object.entries(editorSecurityHeaders())) out[name] = value;
      // The boot document is the one rewritten body (theme defaults). It
      // arrives chunked, so cap by bytes seen: past the cap it isn't the
      // boot document, so flush unmodified and stream the rest. Compressed
      // bodies can't be text-rewritten and stream straight through.
      if (!('content-encoding' in out)) {
        const chunks: Buffer[] = [];
        let buffered = 0;
        let overflowed = false;
        upstreamRes.on('data', (chunk: Buffer) => {
          if (overflowed) return;
          chunks.push(chunk);
          buffered += chunk.length;
          if (buffered > EDITOR_HTML_REWRITE_MAX_BYTES) {
            // Flush including the crossing chunk; bytes are unchanged, so content-length stays exact.
            overflowed = true;
            res.writeHead(upstreamRes.statusCode ?? 502, out);
            res.write(Buffer.concat(chunks));
            chunks.length = 0;
            upstreamRes.pipe(res);
          }
        });
        upstreamRes.on('end', () => {
          if (overflowed) return;
          const body = injectWorkbenchThemeDefaults(Buffer.concat(chunks).toString('utf8'));
          out['content-length'] = String(Buffer.byteLength(body));
          res.writeHead(upstreamRes.statusCode ?? 502, out);
          res.end(body);
        });
        return;
      }
    }
    res.writeHead(upstreamRes.statusCode ?? 502, out);
    // Streamed: workbench bundles are tens of MB.
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

// The editor's integrated terminal is a shell, so logout/shutdown must cut its
// tunnels like terminal sockets, and each tunnel sweeps for token expiry.
const editorTunnels = new EditorTunnelTracker();

/** Raw byte tunnel to the upstream; gates have already run. */
function upgradeEditorSocket(
  req: http.IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
  token: SessionToken,
): void {
  const upstream = CFG.editorUpstream;
  if (!upstream) {
    socket.destroy();
    return;
  }
  // Re-adds Connection/Upgrade after the hop-by-hop strip, else the
  // upstream sees a plain GET and never answers 101.
  const headers = editorUpgradeHeaders(req.headers);
  const target = new URL(req.url ?? '/', upstream.origin);
  const proxied = http.request(target, { method: 'GET', headers });
  proxied.setTimeout(30_000, () => proxied.destroy(new Error('editor upstream upgrade idle')));
  proxied.on('error', err => {
    wsLog.error('editor ws upgrade failed', { error: err });
    socket.destroy();
  });
  // Non-101 answer: forward the status and end.
  proxied.on('response', upstreamRes => {
    socket.write(
      `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ''}\r
` + 'Connection: close\r\n\r\n',
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
    const tunnel = {
      close(): void {
        socket.destroy();
        upstreamSocket.destroy();
      },
    };
    editorTunnels.track(token, tunnel);
    // WS traffic never renews a token, so expiry must be checked here.
    const sweep = setInterval(() => {
      const alive = auth.alive(token);
      if (alive.ok) return;
      if (alive.errorCode === 'no_session') editorTunnels.closeToken(token);
      // database_error: re-check next tick rather than cut a shell over a db hiccup.
    }, PING_INTERVAL_MS).unref();
    const done = (): void => {
      clearInterval(sweep);
      editorTunnels.untrack(token, tunnel);
      tunnel.close();
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
// High-volume paths (the 15 s /api/state poll, assets, editor, apps) log at
// debug: silent on the console, still pushed to loki.
const quietAccessPath = (p: string): boolean =>
  p === route('/api/state') ||
  p.startsWith(route('/_astro/')) ||
  p === route('/sw.js') ||
  p === route('/manifest.webmanifest') ||
  p.startsWith(route('/icons/')) ||
  p.startsWith(route('/editor/')) ||
  p.startsWith(route('/apps/'));

function logAccess(req: http.IncomingMessage, res: http.ServerResponse): void {
  const start = Date.now();
  res.on('finish', () => {
    const p = (req.url ?? '').split('?')[0] ?? '';
    const line = `${req.method} ${p} ${res.statusCode} in ${Date.now() - start}ms`;
    if (quietAccessPath(p)) httpLog.debug(line);
    else httpLog.http(line);
  });
}

// A synchronous throw in a route costs one 500, not the process (and every tmux session with it).
const server = http.createServer((req, res) => {
  hardenResponse(res);
  logAccess(req, res);
  try {
    handle(req, res);
  } catch (err) {
    httpLog.error('request handler error', { error: err });
    if (!res.headersSent) send(res, 500, 'internal error');
    else res.destroy();
  }
});
// Replaced per request by armBodyDeadline()/guardUploadStall().
server.requestTimeout = 0;

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? '').split('?')[0]!;
  const disarmBodyDeadline = armBodyDeadline(req);

  // Before routing: a mismatched Origin must not even touch the login limiter.
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
      if (err) {
        send(res, 400, 'bad request');
        return;
      }
      const parsed = loginBody.safeParse(body);
      if (!parsed.success) {
        authLog.info('login failed: invalid credentials (malformed body)', { ip });
        send(res, 401, 'invalid credentials'); // fail2ban watches 401s
        return;
      }
      const { username, password } = parsed.data;
      if (loginVerifying >= MAX_LOGIN_VERIFY) {
        authLog.warn('login deferred: scrypt queue full (503)', { ip });
        send(res, 503, 'busy, try again', { 'Retry-After': '1' });
        return;
      }
      loginVerifying++;
      auth
        .verify(username, password)
        .then(verified => {
          if (!verified.ok) {
            switch (verified.errorCode) {
              case 'invalid_credentials':
                authLog.info('login failed: invalid credentials', { username, ip });
                send(res, 401, 'invalid credentials');
                return;
              // Not a 401: fail2ban counts those. The login page reads 503 as "try again".
              case 'database_error':
                authLog.error(`login verify db error: ${verified.errorMessage}`);
                send(res, 503, 'busy, try again', { 'Retry-After': '1' });
                return;
              default:
                verified satisfies never;
                return;
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
        .finally(() => {
          loginVerifying--;
        });
    });
    return;
  }

  if (req.method === 'POST' && url === route('/logout')) {
    const token = Auth.sessionToken(req.headers.cookie);
    const dropped = auth.drop(token);
    // End live terminals and editor shells too, not just future requests.
    if (token) {
      closeTokenSockets(token, { type: 'signed-out' });
      editorTunnels.closeToken(token);
      eventsRelay.closeToken(token, { type: 'signed-out' });
    }
    // The token is still valid server-side; say so (the cookie is cleared regardless).
    if (!dropped.ok) {
      authLog.error(`logout failed: ${dropped.errorMessage}`);
      send(res, 500, 'could not end the session', { 'Set-Cookie': clearSessionCookie() });
      return;
    }
    authLog.info('logout');
    send(res, 200, 'ok', { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  // PWA files carry no data and are needed before login exists.
  if (req.method === 'GET' && url.startsWith(CFG.base)) {
    const rel = url.slice(CFG.base.length).replace(/^\//, '');
    if (
      rel === 'sw.js' ||
      rel === 'theme-boot.js' ||
      rel === 'manifest.webmanifest' ||
      rel.startsWith('icons/')
    ) {
      sendClientFile(res, '/' + rel, rel.startsWith('icons/'));
      return;
    }
  }

  const session = auth.valid(Auth.sessionToken(req.headers.cookie));
  if (!session.ok) {
    // The offline shell (precached by the service worker pre-auth) and hashed assets are session-free.
    if (req.method === 'GET' && url === route('/offline')) {
      renderAstro(req, res);
      return;
    }
    if (req.method === 'GET' && url.startsWith(route('/_astro/'))) {
      sendClientFile(res, url.slice(CFG.base.length), true);
      return;
    }
    switch (session.errorCode) {
      case 'no_session':
        break;
      // Fail closed, but not as "signed out": no login page, no 401.
      case 'database_error':
        authLog.error(`session store unavailable: ${session.errorMessage}`);
        send(res, 503, 'session store unavailable, try again', { 'Retry-After': '5' });
        return;
      default:
        session satisfies never;
    }
    // Page GETs render the login page in place, so signing in reloads the
    // requested URL. API, partials and the editor answer 401. /apps/* GETs
    // get the page treatment since app pages and APIs share that prefix.
    if (
      req.method === 'GET' &&
      underBase(url) &&
      !url.startsWith(route('/api/')) &&
      !url.startsWith(route('/partials/')) &&
      !isEditorHttpPath(CFG.base, url)
    ) {
      req.url = route('/login');
      renderAstro(req, res);
      return;
    }
    send(res, 401, 'unauthorized');
    return;
  }

  // Log out everywhere: every token and every terminal ends.
  if (req.method === 'POST' && url === route('/api/logout-all')) {
    const dropped = auth.dropAll();
    closeAllSockets({ type: 'signed-out' });
    editorTunnels.closeAll();
    eventsRelay.closeAll({ type: 'signed-out' });
    if (!dropped.ok) {
      authLog.error(`log out everywhere failed: ${dropped.errorMessage}`);
      send(res, 500, 'could not end the sessions', { 'Set-Cookie': clearSessionCookie() });
      return;
    }
    authLog.info('log out everywhere — every session revoked');
    send(res, 200, 'ok', { 'Set-Cookie': clearSessionCookie() });
    return;
  }

  // Editor bodies may be chunked and large (saves), so they get the stall guard instead of the deadline.
  if (isEditorHttpPath(CFG.base, url)) {
    if (!CFG.editorUpstream) {
      send(res, 404, 'not found');
      return;
    }
    const capped = editorBodyCapStatus(req);
    if (capped === 413) {
      send(res, 413, 'request body too large');
      return;
    }
    disarmBodyDeadline();
    guardUploadStall(req);
    proxyEditorRequest(req, res, CFG.editorUpstream);
    return;
  }

  // Unauthenticated GETs already got the login page and non-GETs a 401.
  if (isAppsHttpPath(CFG.base, url)) {
    handleAppsRequest(
      {
        base: CFG.base,
        socketPath: APPS_SOCK,
        registered: slug => {
          const listed = services.apps.listApps();
          return listed.ok ? listed.data.apps.some(a => a.slug === slug) : null;
        },
      },
      req,
      res,
    );
    return;
  }

  if (req.method === 'GET') {
    if (url.startsWith(route('/_astro/'))) {
      sendClientFile(res, url.slice(CFG.base.length), true);
      return;
    }
    if (url === route('/login')) {
      res.writeHead(302, { Location: CFG.base === '/' ? '/' : CFG.base }).end();
      return;
    }
  }

  // The only place locals are passed.
  if (!underBase(url)) {
    send(res, 404, 'not found');
    return;
  }
  // Astro throws on a bad %-escape; answer it as a client error.
  try {
    decodeURI(url);
  } catch {
    send(res, 400, 'bad request');
    return;
  }
  const capped = bodyCapStatus(req, url);
  if (capped === 413) {
    send(res, 413, 'request body too large');
    return;
  }
  if (capped === 411) {
    send(res, 411, 'request body needs a Content-Length');
    return;
  }
  if (isUpload(req, url)) {
    disarmBodyDeadline();
    guardUploadStall(req);
  }
  renderAstro(req, res, { cybermole: services, session: session.data.token });
}

// ---------- WebSocket → node-pty → tmux attach ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

// Browser subscriptions to the jobs domain-event bus.
const eventsRelay = new EventsRelay({ alive: token => auth.alive(token), log: wsLog });
eventsRelay.start();

// Logout and shutdown must end the terminals a token opened.
const socketsByToken = new Map<SessionToken, Set<WebSocket>>();

function trackSocket(token: SessionToken, ws: WebSocket): void {
  let set = socketsByToken.get(token);
  if (!set) {
    set = new Set();
    socketsByToken.set(token, set);
  }
  set.add(ws);
}
function untrackSocket(token: SessionToken, ws: WebSocket): void {
  const set = socketsByToken.get(token);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socketsByToken.delete(token);
}

/** A peer that never answers the close frame is terminated, so a
 *  logout can't leave a terminal alive on a limp socket. */
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

/** Send `final`, then end every socket authenticated with `token`. */
function closeTokenSockets(token: SessionToken, final: ServerMsg): void {
  const set = socketsByToken.get(token);
  if (!set) return;
  socketsByToken.delete(token);
  for (const ws of set) {
    wsSend(ws, final);
    closeSoon(ws);
  }
}

/** Send `final`, then end every socket, whichever token it used. */
function closeAllSockets(final: ServerMsg): void {
  for (const set of socketsByToken.values()) {
    for (const ws of set) {
      wsSend(ws, final);
      closeSoon(ws);
    }
  }
  socketsByToken.clear();
}

let shuttingDown = false;

server.on('upgrade', (req, socket, head) => {
  const url = (req.url ?? '').split('?')[0]!;
  // Editor upgrades skip the WS rate limiter: VS Code opens several sockets
  // per window, so 30/min/IP would throttle two tabs.
  if (isEditorUpgradePath(CFG.base, url)) {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    if (!CFG.editorUpstream) {
      socket.write(`HTTP/1.1 404 Not Found\r\n${securityHeaderBlock()}\r\n`);
      socket.destroy();
      return;
    }
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
        default:
          return session satisfies never;
      }
      socket.write(`HTTP/1.1 ${status}\r\n${securityHeaderBlock()}\r\n`);
      socket.destroy();
      return;
    }
    upgradeEditorSocket(req, socket, head, session.data.token);
    return;
  }
  if (url === route('/ws/events')) {
    // Same gates as the terminal below, factored out for unit tests.
    const gate = checkEventsUpgrade(req, ipOf(req), {
      shuttingDown: () => shuttingDown,
      allow: ip2 => wsLimiter.allow(ip2),
      originOk,
      validSession: cookie => auth.valid(Auth.sessionToken(cookie)),
    });
    if (!gate.ok) {
      if (gate.reply === 'status') {
        wsLog.warn(`events ws upgrade rejected: ${gate.why}`, { ip: ipOf(req) });
        socket.write(`HTTP/1.1 ${gate.status}\r\n${securityHeaderBlock()}\r\n`);
      } else {
        wsLog.warn(`events ws upgrade rejected: ${gate.why}`, { ip: ipOf(req) });
      }
      socket.destroy();
      return;
    }
    eventsRelay.handleUpgrade(req, socket, head, gate.token);
    return;
  }
  if (url !== route('/ws')) {
    socket.destroy();
    return;
  }
  if (shuttingDown) {
    socket.destroy();
    return;
  }
  const ip = ipOf(req);
  if (!wsLimiter.allow(ip)) {
    wsLog.warn('ws upgrade rate-limited (30 per min per IP)', { ip });
    socket.destroy();
    return;
  }
  // Unlike HTTP, a missing Origin is rejected: the terminal is browser-only.
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
      // Fail closed without calling it signed out.
      case 'database_error':
        authLog.error(`session store unavailable: ${session.errorMessage}`);
        status = '503 Service Unavailable';
        break;
      default:
        return session satisfies never;
    }
    socket.write(`HTTP/1.1 ${status}\r\n${securityHeaderBlock()}\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => attach(ws, session.data.token));
});

interface Pty {
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(): void;
  onData(cb: (d: string) => void): void;
  onExit(cb: () => void): void;
}

function wsSend(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Keepalive ping: keeps idle-timeout proxies (ALB's 60 s) from cutting a quiet
// terminal, and a ping unanswered by the next tick means the peer is gone.
const PING_INTERVAL_MS = 30_000;

function attach(ws: WebSocket, token: SessionToken): void {
  wsLog.debug('ws connected');
  trackSocket(token, ws);
  let p: Pty | null = null;
  // Set once attached: attach/detach log at info, socket open at debug.
  let attachedTo: TmuxSessionName | null = null;
  // Guards the async gap before `p` is set against a second {attach}.
  let starting = false;
  // {resize} usually arrives before the pty exists; spawn at that size, not 80x24.
  let size = { cols: 80, rows: 24 };

  async function spawnTmux(target: TmuxSessionName): Promise<void> {
    // On an absolute socket, attach must not fork a tmux server as this uid.
    const server = await tmux.requireServer();
    if (!server.ok) {
      starting = false;
      wsSend(ws, { type: 'error', message: tmux.SERVER_NOT_RUNNING_MSG });
      return;
    }
    const env = Object.assign({}, process.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HOME: CFG.home,
      PI_CODING_AGENT_DIR: CFG.agentDir,
    });
    let x: Pty;
    try {
      x = pty.spawn('tmux', [...tmux.socketArgs(tmux.SOCKET), 'attach', '-d', '-t', target], {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: CFG.newSessionCwd,
        env,
      }) as Pty;
    } catch (e) {
      starting = false;
      wsSend(ws, { type: 'error', message: 'spawn failed: ' + (e as Error).message });
      return;
    }
    // Hold pty output until the scrollback backfill is sent: the client
    // writes history first, and the held output carries the attach redraw.
    const held: string[] = [];
    let flushing = false;
    x.onData(d => {
      if (flushing) wsSend(ws, { type: 'output', data: d });
      else held.push(d);
    });
    x.onExit(() => {
      wsSend(ws, { type: 'exit', target });
      ws.close();
    });
    p = x;
    attachedTo = target;
    wsSend(ws, { type: 'attached', target, socket: tmux.SOCKET });
    wsLog.info('terminal attached', { target });
    let history: string | null = null;
    try {
      history = await tmux.capturePaneHistory(target);
    } catch (err) {
      // Must never break the attach.
      wsLog.warn('backfill capture threw', { target, error: err });
    }
    if (history !== null) {
      wsSend(ws, { type: 'backfill', data: history });
      wsLog.debug('scrollback backfill sent', { target, bytes: history.length });
    }
    flushing = true;
    for (const d of held) wsSend(ws, { type: 'output', data: d });
    held.length = 0;
  }

  async function onMessage(msg: ClientMsg): Promise<void> {
    if (msg.type === 'input') {
      // Big pastes arrive pre-split by the client; maxPayload bounds each frame.
      if (p) p.write(msg.data);
    } else if (msg.type === 'resize') {
      const c = Math.min(Math.max(Math.trunc(msg.cols) || 80, 10), 500);
      const r = Math.min(Math.max(Math.trunc(msg.rows) || 24, 4), 200);
      size = { cols: c, rows: r };
      if (p) {
        try {
          p.resize(c, r);
        } catch {
          /* race on exit */
        }
      }
    } else if (msg.type === 'attach' && !p && !starting) {
      starting = true;
      const failed = (message: string): void => {
        starting = false;
        wsSend(ws, { type: 'error', message });
      };
      if (msg.mode === 'terminal') {
        // tmux alive: reattach. tmux dead: respawn the tab's command at the
        // workspace cwd (the db row outlives the session).
        const id = TerminalIdSchema.safeParse(msg.id);
        if (!id.success) {
          failed('bad terminal id');
          return;
        }
        const found = await services.workspaces.terminalForAttach(id.data);
        if (!found.ok) {
          failed(
            found.errorCode === 'database_error'
              ? 'could not read the terminal'
              : 'no such terminal',
          );
          return;
        }
        const name = tmux.terminalSessionName(id.data);
        if (!(await tmux.hasSession(name))) {
          // The workspace's auto-opened tab respawns the agent; others a shell.
          const command = found.data.agent
            ? resolvedAgentCommand(stateDb)
            : resolvedShellCommand(stateDb);
          if (!command.ok) {
            failed('could not read the terminal defaults');
            return;
          }
          const spawned = await spawnTerminalSession(
            name,
            found.data.cwd,
            splitCommandLine(command.data.value),
          );
          if (!spawned.ok) {
            switch (spawned.errorCode) {
              case 'server_not_running':
                failed(tmux.SERVER_NOT_RUNNING_MSG);
                return;
              case 'tmux_error':
                failed('could not start terminal session');
                return;
              default:
                spawned satisfies never;
            }
            return;
          }
          wsLog.info(`terminal ${id.data} respawned (${name} at ${found.data.cwd})`);
        }
        await spawnTmux(name);
      } else if (msg.mode === 'run') {
        // A job run's session never respawns: the run dies with its command.
        const target = TmuxSessionNameSchema.safeParse(msg.target);
        if (!target.success) {
          failed('bad target');
          return;
        }
        if (!(await tmux.hasSession(target.data))) {
          failed('no such run session');
          return;
        }
        await spawnTmux(target.data);
      }
    }
  }

  ws.on('message', raw => {
    const msg = parseClientMsg(Buffer.from(raw as Buffer).toString('utf8'));
    if (!msg) return;
    onMessage(msg).catch(err => wsLog.error('ws message handler error', { error: err }));
  });

  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const keepalive = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    // Bind established terminals to token expiry too. auth.alive doesn't
    // renew: WS traffic never slides a token.
    const live = auth.alive(token);
    if (!live.ok) {
      switch (live.errorCode) {
        case 'no_session':
          closeTokenSockets(token, { type: 'signed-out' });
          return;
        // Don't sign a terminal out over a db hiccup; re-check next tick.
        case 'database_error':
          authLog.error(`session store unavailable: ${live.errorMessage}`);
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
  }, PING_INTERVAL_MS);

  ws.on('close', () => {
    untrackSocket(token, ws);
    clearInterval(keepalive);
    if (p) {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
    }
    if (attachedTo) wsLog.info('terminal detached', { target: attachedTo });
  });
  ws.on('error', () => {
    if (p) {
      try {
        p.kill();
      } catch {
        /* noop */
      }
    }
  });
}

server.listen(CFG.port, CFG.host, () => {
  bootLog.info(
    `cybermole listening on ${CFG.host}:${CFG.port} base ${CFG.base} ` +
      `(tmux socket ${tmux.SOCKET}, command "${ENV.CYBERMOLE_COMMAND}", client ${CFG.clientDir})`,
  );
  // Only for the env default: resolving the db one would open the state db
  // eagerly (the e2e webServer boots before its workspace reset).
  if (ENV.CYBERMOLE_AGENT_COMMAND === PI_BIN) {
    execFile(PI_BIN, ['--version'], { timeout: 5000 }, (err, out) =>
      bootLog.info(
        err ? `pi: version check failed (${(err as Error).message})` : `pi ${String(out).trim()}`,
      ),
    );
  }
});

// ---------- graceful shutdown ----------
// Steps run in order; the deadline stops a stuck socket holding the stop.
const SHUTDOWN_DEADLINE_MS = 5000;
const whenClosed = new Promise<void>(resolve => server.once('close', resolve));
const shutdownSteps: Array<() => void | Promise<void>> = [
  () => {
    shutdownScheduler();
  },
  () => {
    autoUpdater.stop();
  },
  // Before the internal API: the host discovers over that socket.
  () => {
    return appHostSupervisor?.stop();
  },
  () => {
    return internalApi?.close();
  },
  () => {
    server.close();
  },
  () => {
    closeAllSockets({ type: 'restart' });
  },
  () => {
    eventsRelay.stop({ type: 'restart' });
  },
  () => {
    editorTunnels.closeAll();
  },
  () => {
    // Keep-alive sockets go idle after the console's last re-poll; a
    // one-shot closeIdleConnections would miss them.
    const sweep = setInterval(() => server.closeIdleConnections(), 250);
    return whenClosed.finally(() => clearInterval(sweep));
  },
  () => closeLogger(),
];

function shutdown(signal: string): void {
  if (shuttingDown) process.exit(0); // a second signal skips the drain
  shuttingDown = true;
  shutdownLog.info(`${signal} received — shutting down`);
  const deadline = setTimeout(() => {
    shutdownLog.error(`shutdown: drain unfinished after ${SHUTDOWN_DEADLINE_MS}ms — exiting`);
    process.exit(0);
  }, SHUTDOWN_DEADLINE_MS);
  void (async () => {
    for (const step of shutdownSteps) {
      try {
        await step();
      } catch (err) {
        shutdownLog.error('shutdown step failed', { error: err });
      }
    }
    clearTimeout(deadline);
    process.exit(0);
  })();
}
// on(), not once(): a repeated signal must hit the fast-exit path, not the default handler.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
