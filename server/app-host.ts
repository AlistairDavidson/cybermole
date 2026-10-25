// app-host.ts — the app host (task/app-host, docs/plans/apps-plan.md §3): a
// mini main.ts running on the WORKSPACE side of the privilege split,
// listening on its own unix socket (CYBERMOLE_APPS_SOCK — the
// CYBERMOLE_SOCK rules verbatim: unset = /run/cybermole/apps.sock when
// the shared dir exists, else <state dir>/apps.sock; empty = the apps
// surface is off; a set value must be absolute). It never serves TCP:
// the socket's file mode (0660, the shared setgid group in compose) is
// the gate, exactly the internal API's stance — app code runs as the
// workspace uid with exactly a terminal's powers (plan §8), reachable
// for browsers only through the web container's future /apps/* proxy
// (branch 2), which adds the session gate.
//
// The loop: DISCOVER registered apps (the internal API's read-only
// GET /apps over CYBERMOLE_SOCK, plus each row's app.json + dist/),
// MOUNT each complete one (cache-busted dynamic import of its built
// dist/server/entry.mjs — the @astrojs/node middleware `handler`, the
// same shape server/main.ts loads for the console — plus its dist/client
// static assets), and RELOAD on demand (POST /_admin/reload — the single
// sync point: register/unregister write rows, reload makes the mounts
// match them). Row + manifest + build = mounted; anything missing is
// skipped and reported (/_admin/status, logs). A throwing app handler is
// a 500 for that app's paths only — the main.ts crash-guard stance, per
// mount; a middleware that fails to import is a skipped-and-reported app.
//
// Importable without side effects — unit tests boot this module alone on
// a tmp-dir socket against a real internal-api fixture. The env rules
// live in src/lib/env.ts (readAppsSocket); this module takes resolved
// absolute paths.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { componentLogger } from '../src/lib/logger';
import { readAppsSocket, readInternalApiSocket } from '../src/lib/env';
import { requestInternalApi } from '../src/lib/internal-api-client';
import { AppSlugSchema } from '@cybermole/app-kit';
import { probeSocketFile } from './internal-api';

const log = componentLogger('app-host');

// ---------- types ----------

/** The @Astrojs/node middleware export every mounted app provides — the
 *  same shape server/main.ts loads from the console's dist/server/entry.mjs
 *  (docs/plans/apps-plan.md §3: "the same static+middleware split main.ts
 *  performs for the console"). Apps get NO locals: the console's
 *  { cybermole, session } never crosses into app code (plan §8). */
type AppHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (err?: unknown) => void,
) => void;

/** app.json — the app's self-description (plan §2: the db row stays
 *  structural; the manifest is the app's own file). slug is the mount
 *  identity cross-check: the ROW's slug is what registration means, and
 *  the app's base path is baked as /apps/<slug> at build — a manifest
 *  that disagrees names a tree whose baked base will not match the
 *  mount, so it is skipped, not served broken. */
interface AppManifest {
  name: string;
  description: string | null;
  slug: string | null;
}

interface MountedApp {
  readonly slug: string;
  /** '/apps/<slug>' — the baked base the app was built with. */
  readonly base: string;
  readonly cwd: string;
  readonly manifest: AppManifest;
  readonly entryPath: string;
  readonly clientDir: string;
  readonly handler: AppHandler;
  readonly importedAt: number;
}

interface SkippedApp {
  readonly slug: string;
  readonly reason: string;
}

/** One app row as the internal API's GET /apps answers it (AppState,
 *  src/lib/types.ts). */
interface AppRow {
  id: string;
  name: string;
  slug: string;
  cwd: string | null;
  order: number;
}

export interface AppHostDeps {
  /** the host's own socket path (env.ts readAppsSocket — never null here;
   *  an empty CYBERMOLE_APPS_SOCK means the host does not run at all). */
  socketPath: string;
  /** the internal API's socket (env.ts readInternalApiSocket) — the
   *  discovery source. The host requires it: without the internal API
   *  there are no rows to mount. */
  internalSocketPath: string;
  /** boot-discovery retry base delay (backoff doubles to 10 s). Default
   *  2 s; tests inject milliseconds. */
  retryDelayMs?: number;
  /** per-call discovery timeout against the internal socket. Default 5 s —
   *  a listener that accepted but never answers must not hang the boot
   *  retry loop. */
  discoveryTimeoutMs?: number;
}

/** What one reload did — the report both /_admin/reload answers with and
 *  the boot sync logs. */
export interface ReloadReport {
  /** the scoped slug, null = every app */
  slug: string | null;
  /** rows the internal API answered (all scopes see this; it is the row
   *  count the sync ran against) */
  rows: number;
  mounted: string[];
  reimported: string[];
  dropped: string[];
  skipped: SkippedApp[];
}

export interface AppHostStatus {
  me: 'app-host';
  pid: number;
  uptimeS: number;
  socket: string;
  internalSocket: string;
  /** false while the boot retry loop is still waiting for the internal
   *  API (the compose boot race) — the socket answers, with no mounts. */
  booted: boolean;
  mounted: Array<{
    slug: string;
    base: string;
    cwd: string;
    name: string;
    description: string | null;
    entry: string;
    importedAt: number;
  }>;
  skipped: SkippedApp[];
}

export interface AppHostHandle {
  readonly socketPath: string;
  /** Re-run discovery, then mount/re-import/drop (reload's core — the
   *  single sync point, plan §3). Rejects on discovery failure (the
   *  internal API unreachable/erroring): the registry stands as-is. */
  reload(slug?: string): Promise<ReloadReport>;
  status(): AppHostStatus;
  /** Stop listening, let in-flight requests drain, unlink the socket
   *  file (best-effort — a crash leaves it behind and the next boot's
   *  stale-socket check removes it). */
  close(): Promise<void>;
}

/** The socket file exists AND answers — another app host owns it (a
 *  second workspace container on the same socket dir, a stray process).
 *  main() exits 1 on it: the supervisor restarts the host, and the boot
 *  stays loud instead of serving nothing. */
export class AppsSocketOwnedError extends Error {
  constructor(readonly socketPath: string) {
    super(
      `another app host owns the socket (${socketPath}) — stop it, or point ` +
        'CYBERMOLE_APPS_SOCK elsewhere',
    );
    this.name = 'AppsSocketOwnedError';
  }
}

// ---------- small plumbing (main.ts / internal-api.ts shapes) ----------

/** The built entry's middleware graph must be self-contained apart from
 *  node: builtins (plan §5) — serve-time resolution through a symlink an
 *  app's extra install could disturb is the failure mode; the fixture's
 *  build is gated on it (tools/check-app-selfcontained.mjs). */
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

function send(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJSON(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// The console's header set (server/main.ts), filled-in-absent so an app
// setting its own CSP keeps control. App content reaches browsers through
// the web proxy behind the session gate (branch 2); the host sends the
// posture for socket-local clients and the proxied path alike.
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' wss:; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/** Arm `res` so the security headers ride on every response (main.ts's
 *  hardenResponse: injection at writeHead AND end, idempotent, absent
 *  headers only). */
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

function logAccess(req: http.IncomingMessage, res: http.ServerResponse): void {
  const start = Date.now();
  res.on('finish', () => {
    log.http(
      `${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} in ${Date.now() - start}ms`,
    );
  });
}

// The reload body's policy (the internal API's): 10 KiB, JSON, a
// declared length — the body is an optional {slug} and nothing more.
const BODY_MAX_BYTES = 10 * 1024;

function bodyCapStatus(req: http.IncomingMessage): 411 | 413 | null {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const declared = req.headers['content-length'];
  if (declared === undefined) {
    return req.headers['transfer-encoding'] !== undefined ? 411 : null;
  }
  return Number(declared) <= BODY_MAX_BYTES ? null : 413;
}

/** The reload body: {} when empty, or {slug?} (a string). */
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > BODY_MAX_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          resolve(null);
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// ---------- discovery ----------

/** Row + manifest + build, checked — or the reason it cannot mount. The
 *  fs probes are sync and cheap: one reload per register/rebuild, not a
 *  hot path. */
function inspectRow(
  row: AppRow,
):
  | { ok: true; manifest: AppManifest; entryPath: string; clientDir: string }
  | { ok: false; reason: string } {
  try {
    return inspectRowChecked(row);
  } catch (err) {
    // A malformed tree (permissions, a half-deleted dist, a race between
    // the probes and the reads) must degrade to a SKIP reason — never
    // reject the sync and poison every other app's mount with it.
    return { ok: false, reason: `could not inspect the tree: ${(err as Error).message}` };
  }
}

function inspectRowChecked(
  row: AppRow,
):
  | { ok: true; manifest: AppManifest; entryPath: string; clientDir: string }
  | { ok: false; reason: string } {
  if (row.cwd === null)
    return { ok: false, reason: 'row has no cwd (a console group row, not an app tree)' };
  if (!fs.existsSync(row.cwd)) return { ok: false, reason: `cwd does not exist: ${row.cwd}` };
  const manifestPath = path.join(row.cwd, 'app.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, reason: 'app.json missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `app.json is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'app.json is not an object' };
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    return { ok: false, reason: 'app.json: name is required' };
  }
  const description = typeof raw.description === 'string' ? raw.description : null;
  const slug = typeof raw.slug === 'string' ? raw.slug : null;
  if (slug !== null && slug !== row.slug) {
    return {
      ok: false,
      reason: `app.json slug "${slug}" does not match the row slug "${row.slug}" — the baked base would not match the mount`,
    };
  }
  const entryPath = path.join(row.cwd, 'dist', 'server', 'entry.mjs');
  const clientDir = path.join(row.cwd, 'dist', 'client');
  if (!fs.existsSync(entryPath)) {
    return { ok: false, reason: `dist/server/entry.mjs missing (${entryPath}) — build the app` };
  }
  if (!fs.existsSync(clientDir)) {
    return { ok: false, reason: `dist/client missing (${clientDir}) — build the app` };
  }
  if (!fs.statSync(clientDir).isDirectory()) {
    return { ok: false, reason: `dist/client is not a directory (${clientDir})` };
  }
  return { ok: true, manifest: { name: raw.name.trim(), description, slug }, entryPath, clientDir };
}

// ---------- the host ----------

class AppHost {
  private readonly mounted = new Map<string, MountedApp>();
  private skipped: SkippedApp[] = [];
  private booted = false;
  private readonly startedAt = Date.now();
  /** serializes reloads (a boot retry landing on a manual poke) — the
   *  registry is the shared state. Queued as a FUNCTION, not a started
   *  promise: an async IIFE would already be running when it chains. */
  private reloadChain: Promise<unknown> = Promise.resolve();
  private importCounter = 0;
  /** set by close(): the boot-retry loop checks it every pass, and the
   *  pending sleep is woken + unref'd so a closed host can never hold
   *  the process open (a retry timer outliving its tests hung the unit
   *  run once — never again). */
  private stopped = false;
  private wakeRetry: (() => void) | null = null;
  /** resolves once the FIRST boot discovery attempt has settled (success
   *  or failure) — startAppHost awaits it, so a caller that then calls
   *  reload() deterministically runs the SECOND sync, never a race with
   *  the boot pass (a row created right after boot landed either pass).
   *  The loop itself keeps retrying in the background. */
  private resolveFirstSync!: () => void;
  readonly firstSync = new Promise<void>(resolve => {
    this.resolveFirstSync = resolve;
  });

  constructor(private readonly deps: AppHostDeps) {}

  /** The boot retry's sleep — resolves early when stop() wakes it, and
   *  unref'd so even a lost loop cannot keep the event loop alive. */
  private retrySleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.wakeRetry = null;
        resolve();
      }, ms).unref();
      this.wakeRetry = () => {
        clearTimeout(timer);
        this.wakeRetry = null;
        resolve();
      };
    });
  }

  /** Stop the boot-retry loop (close() calls this). Idempotent; a loop
   *  already past its last check simply returns on the next one. */
  stop(): void {
    this.stopped = true;
    this.wakeRetry?.();
  }

  /** Boot sync with the compose-boot-race retry: the web server (and its
   *  internal API) may not be listening when the workspace container
   *  comes up. Backoff from retryDelayMs, doubling to 10 s, forever —
   *  rows persist in the db and the next successful pass mounts them; a
   *  loud line per attempt keeps the wait visible. Stops silently once
   *  close() has run. */
  bootWithRetry(): void {
    const base = this.deps.retryDelayMs ?? 2000;
    void (async () => {
      let delay = base;
      let attempt = 1;
      for (;;) {
        if (this.stopped) return;
        try {
          const report = await this.reload();
          this.booted = true;
          log.info(
            `app host ready on ${this.deps.socketPath}: ${report.mounted.length} mounted, ` +
              `${report.skipped.length} skipped, ${report.rows} registered row(s)`,
          );
          this.resolveFirstSync();
          return;
        } catch (err) {
          this.resolveFirstSync();
          if (this.stopped) return;
          log.warn(
            `discovery failed (attempt ${attempt}): ${(err as Error).message} — ` +
              `retrying in ${delay}ms (waiting for the internal API on ${this.deps.internalSocketPath})`,
          );
          await this.retrySleep(delay);
          delay = Math.min(delay * 2, 10_000);
          attempt++;
        }
      }
    })();
  }

  /** GET /apps over the internal socket → rows. Transport failures, non-200
   *  answers and malformed bodies all throw (the boot retry loop re-tries;
   *  a reload surfaces the error to its caller). */
  private async discoverRows(): Promise<AppRow[]> {
    const answer = await requestInternalApi(
      this.deps.internalSocketPath,
      { method: 'GET', path: '/apps' },
      { timeoutMs: this.deps.discoveryTimeoutMs ?? 5000 },
    );
    if (answer.status !== 200) {
      throw new Error(`the internal API answered ${answer.status} on GET /apps: ${answer.body}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw new Error('the internal API answered a non-JSON body on GET /apps');
    }
    const apps = (parsed as { apps?: unknown }).apps;
    if (!Array.isArray(apps))
      throw new Error('the internal API answered no apps array on GET /apps');
    return apps.filter(
      (a): a is AppRow =>
        typeof a === 'object' && a !== null && typeof (a as AppRow).slug === 'string',
    );
  }

  /** Cache-busted dynamic import of a built entry: the query makes every
   *  reload a fresh module record, so a rebuilt entry (and its hashed
   *  chunks) is re-read from disk instead of served from the ESM cache.
   *  The superseded record stays cached (ESM has no eviction) — reloads
   *  are rare, deliberate events, not a loop. */
  private async importHandler(entryPath: string): Promise<AppHandler> {
    const url = pathToFileURL(entryPath);
    url.search = `v=${Date.now()}-${this.importCounter++}`;
    const m: { handler?: unknown } = await import(url.href);
    if (typeof m.handler !== 'function') {
      throw new Error('dist/server/entry.mjs exports no handler function');
    }
    return m.handler as AppHandler;
  }

  /** Re-run discovery, then mount/re-import/drop. A named slug scopes the
   *  re-import/drop to that app (others carry over untouched); every
   *  other app is re-imported. Import failures on an app that was
   *  already mounted keep the previous build serving — a poison rebuild
   *  must not take a working mount down (plan §3's per-app tolerance). */
  async reload(slug: string | null = null): Promise<ReloadReport> {
    // Serialize: the boot retry, a manual poke and a scoped reload all
    // mutate one registry — queued as a function, not a started promise.
    const run = this.reloadChain.catch(() => undefined).then(() => this.doReload(slug));
    this.reloadChain = run.catch(() => undefined);
    return run;
  }

  private async doReload(slug: string | null): Promise<ReloadReport> {
    const rows = await this.discoverRows();
    this.booted = true;
    const report: ReloadReport = {
      slug,
      rows: rows.length,
      mounted: [],
      reimported: [],
      dropped: [],
      skipped: [],
    };
    const next = new Map<string, MountedApp>();
    for (const row of rows) {
      const scoped = slug === null || row.slug === slug;
      const existing = this.mounted.get(row.slug);
      if (!scoped && existing) {
        next.set(row.slug, existing); // another app's scope: carry over
        continue;
      }
      const inspected = inspectRow(row);
      if (!inspected.ok) {
        report.skipped.push({ slug: row.slug, reason: inspected.reason });
        continue;
      }
      if (existing) {
        try {
          const handler = await this.importHandler(inspected.entryPath);
          next.set(row.slug, { ...existing, handler, importedAt: Date.now() });
          report.reimported.push(row.slug);
        } catch (err) {
          report.skipped.push({
            slug: row.slug,
            reason: `re-import failed, previous build still mounted: ${(err as Error).message}`,
          });
          next.set(row.slug, existing);
        }
        continue;
      }
      try {
        const handler = await this.importHandler(inspected.entryPath);
        const mounted: MountedApp = {
          slug: row.slug,
          base: `/apps/${row.slug}`,
          cwd: row.cwd as string,
          manifest: inspected.manifest,
          entryPath: inspected.entryPath,
          clientDir: inspected.clientDir,
          handler,
          importedAt: Date.now(),
        };
        next.set(row.slug, mounted);
        report.mounted.push(row.slug);
        log.info(`mounted app "${inspected.manifest.name}" (${row.slug}) at ${mounted.base}`);
      } catch (err) {
        report.skipped.push({
          slug: row.slug,
          reason: `entry import failed: ${(err as Error).message}`,
        });
      }
    }
    for (const [name, mounted] of this.mounted) {
      if (next.has(name)) continue;
      if (slug !== null && name !== slug) {
        next.set(name, mounted); // outside the scope: keep
        continue;
      }
      report.dropped.push(name);
      log.info(`dropped app mount ${name} (unregistered or incomplete)`);
    }
    this.mounted.clear();
    for (const [name, mounted] of next) this.mounted.set(name, mounted);
    this.skipped = report.skipped;
    return report;
  }

  status(): AppHostStatus {
    return {
      me: 'app-host',
      pid: process.pid,
      uptimeS: Math.floor((Date.now() - this.startedAt) / 1000),
      socket: this.deps.socketPath,
      internalSocket: this.deps.internalSocketPath,
      booted: this.booted,
      mounted: [...this.mounted.values()].map(m => ({
        slug: m.slug,
        base: m.base,
        cwd: m.cwd,
        name: m.manifest.name,
        description: m.manifest.description,
        entry: m.entryPath,
        importedAt: m.importedAt,
      })),
      skipped: this.skipped,
    };
  }

  mountFor(url: string): MountedApp | null {
    if (!url.startsWith('/apps/')) return null;
    const slug = url.slice('/apps/'.length).split('/')[0] ?? '';
    return this.mounted.get(slug) ?? null;
  }

  /** A static file from the app's dist/client (hashed _astro/ assets
   *  cache-busted, everything else no-store) — served BEFORE the
   *  middleware, the adapter's own standalone split. */
  serveClientFile(res: http.ServerResponse, m: MountedApp, url: string): boolean {
    const rel = url.slice(m.base.length);
    const file = path.normalize(path.join(m.clientDir, rel));
    if (!file.startsWith(m.clientDir + path.sep)) return false; // traversal: fall through to 404
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const hashed = rel.startsWith('/_astro/');
    fs.readFile(file, (err, data) => {
      if (err) {
        send(res, 404, 'not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': hashed ? 'public, max-age=3600' : 'no-store',
      });
      res.end(data);
    });
    return true;
  }
}

// ---------- the listener ----------

export async function startAppHost(deps: AppHostDeps): Promise<AppHostHandle> {
  fs.mkdirSync(path.dirname(deps.socketPath), { recursive: true });
  if (fs.existsSync(deps.socketPath)) {
    const state = await probeSocketFile(deps.socketPath);
    if (state === 'live') throw new AppsSocketOwnedError(deps.socketPath);
    log.info(`removing stale app-host socket ${deps.socketPath}`);
    fs.rmSync(deps.socketPath, { force: true });
  }
  const host = new AppHost(deps);
  const server = http.createServer((req, res) => {
    hardenResponse(res);
    logAccess(req, res);
    // Crash guard, main.ts's stance: a throwing dispatch costs one 500,
    // never the process — and per-mount guards below keep one app's
    // throw from touching another's paths.
    dispatch(host, req, res).catch(err => {
      log.error('request handler error', { error: err });
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err);
    server.once('error', onListenError);
    server.listen(deps.socketPath, () => {
      server.off('error', onListenError);
      server.on('error', err => log.error('server error', { error: err }));
      resolve();
    });
  });
  fs.chmodSync(deps.socketPath, 0o660);
  log.info(
    `app host listening on ${deps.socketPath} (0660) — discovering apps via ${deps.internalSocketPath}`,
  );
  host.bootWithRetry();
  await host.firstSync; // the first discovery attempt has settled (either way)
  return {
    socketPath: deps.socketPath,
    reload: slug => host.reload(slug ?? null),
    status: () => host.status(),
    close() {
      host.stop(); // the boot-retry loop must not outlive the listener
      return new Promise(resolve => {
        server.close(() => {
          try {
            fs.rmSync(deps.socketPath, { force: true });
          } catch (err) {
            log.warn(`could not unlink ${deps.socketPath}: ${(err as Error).message}`);
          }
          resolve();
        });
        server.closeIdleConnections(); // keep-alive agents must not hold the drain
      });
    },
  };
}

/** Socket-local admin routes + per-app dispatch. Everything else under
 *  /apps/<slug>/ is the app's own HTTP, forwarded verbatim (plan §3:
 *  actions are the app's routes — the host invents no parallel RPC). */
async function dispatch(
  host: AppHost,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = (req.url ?? '').split('?')[0] ?? '/';

  if (url === '/_admin/status') {
    if (req.method === 'GET') return sendJSON(res, 200, host.status());
    return sendJSON(res, 404, { error: 'not found', code: 'not_found' });
  }
  if (url === '/_admin/reload') {
    if (req.method !== 'POST') return sendJSON(res, 404, { error: 'not found', code: 'not_found' });
    const capped = bodyCapStatus(req);
    if (capped === 413)
      return sendJSON(res, 413, { error: 'request body too large', code: 'body_too_large' });
    if (capped === 411) {
      return sendJSON(res, 411, {
        error: 'request body needs a Content-Length',
        code: 'length_required',
      });
    }
    const body = await readBody(req);
    if (body === null) return sendJSON(res, 400, { error: 'bad request', code: 'bad_request' });
    let slug: string | null = null;
    if (body.slug !== undefined) {
      const parsed = AppSlugSchema.safeParse(body.slug);
      if (!parsed.success) {
        return sendJSON(res, 400, { error: 'invalid app slug', code: 'invalid_app_slug' });
      }
      slug = parsed.data;
    }
    try {
      return sendJSON(res, 200, await host.reload(slug));
    } catch (err) {
      log.error('reload failed', { error: err });
      return sendJSON(res, 503, {
        error: `reload failed: ${(err as Error).message}`,
        code: 'discovery_failed',
      });
    }
  }

  const mount = host.mountFor(url);
  if (mount === null) {
    return sendJSON(res, 404, { error: 'no such app', code: 'app_not_mounted' });
  }
  // Static assets first (the adapter's split), then the app's middleware.
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (host.serveClientFile(res, mount, url)) return;
  }
  try {
    mount.handler(req, res, err => {
      if (err) {
        log.error(`app ${mount.slug} handler passed an error`, { error: err });
        if (!res.headersSent) send(res, 500, 'app error');
        else res.destroy();
        return;
      }
      // next() with no error: the app's route table knows no such path.
      send(res, 404, 'not found');
    });
  } catch (err) {
    // Per-mount crash guard (plan §3): one app's throw is a 500 on ITS
    // paths only — never the process, never a sibling app.
    log.error(`app ${mount.slug} handler threw`, { error: err });
    if (!res.headersSent) send(res, 500, 'app error');
    else res.destroy();
  }
}

// ---------- the entry ----------

/** Resolve the sockets and serve. Env rules are env.ts's: CYBERMOLE_APPS_SOCK
 *  empty = the apps surface is off — the host exits 0 with a loud line
 *  (clients must fail with their own clear errors); a non-absolute value
 *  is an operator wiring mistake: stderr + exit 1, the web server's
 *  stop-the-boot stance. The host also REQUIRES the internal API (its
 *  discovery source): CYBERMOLE_SOCK empty is a boot error — there are
 *  no rows to mount without it. */
export async function main(): Promise<void> {
  let appsSocket: string | null;
  let internalSocket: string | null;
  try {
    appsSocket = readAppsSocket();
    internalSocket = readInternalApiSocket();
  } catch (err) {
    console.error(`cybermole app-host: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (appsSocket === null) {
    log.warn(
      'apps surface off (CYBERMOLE_APPS_SOCK is empty) — the app host is not listening; ' +
        'clients (the web proxy, reload, the app MCP shim) must fail with a clear error',
    );
    return;
  }
  if (internalSocket === null) {
    log.error(
      'the app host needs the internal API (CYBERMOLE_SOCK is empty) — it cannot discover ' +
        'apps without it; set CYBERMOLE_SOCK, or disable the apps surface with an empty CYBERMOLE_APPS_SOCK',
    );
    process.exitCode = 1;
    return;
  }
  const host = await startAppHost({ socketPath: appsSocket, internalSocketPath: internalSocket });
  const shutdown = (signal: string): void => {
    log.info(`${signal} received — shutting down`);
    void host
      .close()
      .catch(err => log.error(`close failed: ${(err as Error).message}`))
      .finally(() => process.exit(0));
    setTimeout(() => {
      log.error('shutdown: drain unfinished after 5s — exiting');
      process.exit(0);
    }, 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// The self-exec guard in the CommonJS build's terms (the compiled
// `import.meta.url === argv[1]` idiom — the server build emits CJS; see
// server/mcp.ts's note). This file is both the importable module (unit
// tests) and a runnable entry (the workspace entrypoint).
if (require.main === module) {
  main().catch(err => {
    console.error(`cybermole app-host: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
