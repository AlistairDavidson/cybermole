// App host: runs on the workspace side, serving registered apps over its own
// unix socket (CYBERMOLE_APPS_SOCK, file mode 0660 as the gate). Browsers
// reach it only through the web server's session-gated /apps/* proxy.
//
// Discovers app rows over the internal API, mounts each complete one (app.json
// + built dist/), and re-syncs on POST /_admin/reload. Mounted apps are also
// fs-watched (their app.json and built dist/ tree): a settled burst of disk
// changes auto-reloads that one slug. A watcher failure is a logged line, so
// the verb-driven reload remains the fallback. A throwing app is a 500 on its
// own paths only.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Duplex } from 'node:stream';
import { componentLogger } from '../src/lib/platform/logger';
import { readAppsSocket, readBase, readInternalApiSocket } from '../src/lib/platform/env';
import { requestInternalApi } from '../src/lib/platform/internal-api-client';
import { AppSlugSchema } from '@cybermole/app-kit';
import { debounceTrailing } from '../src/lib/platform/debounce';
import {
  hardenResponse,
  logAccess,
  resolveUnderDir,
  securityHeaderBlock,
  sendStaticFile,
  sendJSON,
  sendText,
} from '../src/lib/platform/http-serve';
import { probeSocketFile } from './internal-api';

const log = componentLogger('app-host');

// ---------- types ----------

/** The @astrojs/node middleware export. Apps get no locals: the console's
 *  { cybermole, session } never reaches app code. */
type AppHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (err?: unknown) => void,
) => void;

/** The app's optional WS entry (dist/server/ws.mjs): handed raw upgrades
 *  under the app's base. See runtime/app-starter/README.md § WebSocket routes. */
type AppUpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;

/** A manifest slug that disagrees with the row would have a baked base that
 *  doesn't match the mount, so the app is skipped. */
interface AppManifest {
  name: string;
  description: string | null;
  slug: string | null;
}

interface MountedApp {
  readonly slug: string;
  /** `<console base>/apps/<slug>`, baked in at build (the gate re-bakes it
   *  when the console base changes). */
  readonly base: string;
  readonly cwd: string;
  readonly manifest: AppManifest;
  readonly entryPath: string;
  readonly clientDir: string;
  readonly handler: AppHandler;
  /** null: the app ships no ws entry, so upgrades under it 404. */
  readonly upgrade: AppUpgradeHandler | null;
  /** set when a ws entry exists but failed to import — upgrades answer 503. */
  readonly upgradeError: string | null;
  readonly importedAt: number;
}

interface SkippedApp {
  readonly slug: string;
  readonly reason: string;
}

interface AppRow {
  id: string;
  name: string;
  slug: string;
  cwd: string | null;
  order: number;
}

export interface AppHostDeps {
  /** Never null here: an empty CYBERMOLE_APPS_SOCK means the host doesn't run. */
  socketPath: string;
  /** Required: the discovery source. */
  internalSocketPath: string;
  /** Boot-discovery retry base delay, doubling to 10 s. Default 2 s. */
  retryDelayMs?: number;
  /** Default 5 s: a listener that accepts but never answers mustn't hang the boot loop. */
  discoveryTimeoutMs?: number;
  /** Default true: fs-watch auto-reload of mounted apps. */
  watch?: boolean;
  /** Default 300: per-app debounce that collapses a build's file burst. */
  watchDebounceMs?: number;
  /** Injectable fs.watch stand-in for the tests (errors, close tracking). */
  watchFactory?: AppWatchFactory;
  /** The console's normalized URL base (readBase() shape: '/' at the site
   *  root). Apps mount — and bake — at `<base>/apps/<slug>`, so a subpath
   *  console serves subpath apps with no proxy or nginx gymnastics.
   *  Default: the env value. */
  base?: string;
}

export interface ReloadReport {
  /** null = every app */
  slug: string | null;
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
  /** false while waiting for the internal API at boot. */
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
  /** The fs-watch auto-reload state (absent apps are not being watched). */
  watch: {
    debounceMs: number;
    apps: Array<{ slug: string; autoReloads: number }>;
  };
}

export interface AppHostHandle {
  readonly socketPath: string;
  /** Rejects on discovery failure, leaving the registry as-is. */
  reload(slug?: string): Promise<ReloadReport>;
  status(): AppHostStatus;
  /** Unlink is best-effort; the next boot's stale-socket check covers a crash. */
  close(): Promise<void>;
}

/** main() exits 1 on it, so the supervisor restarts the host loudly. */
export class AppsSocketOwnedError extends Error {
  constructor(readonly socketPath: string) {
    super(
      `another app host owns the socket (${socketPath}) — stop it, or point ` +
        'CYBERMOLE_APPS_SOCK elsewhere',
    );
    this.name = 'AppsSocketOwnedError';
  }
}

// ---------- admin body policy ----------

// The reload body is just an optional {slug}.
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

function inspectRow(row: AppRow):
  | {
      ok: true;
      manifest: AppManifest;
      entryPath: string;
      clientDir: string;
      wsEntryPath: string | null;
      /** The base the build baked in (dist/route-table.json), when the
       *  build records one; null = unknown (legacy build, or no table). */
      bakedBase: string | null;
      /** A route-table.json exists (its base may still be unknown). */
      hasTable: boolean;
    }
  | { ok: false; reason: string } {
  try {
    return inspectRowChecked(row);
  } catch (err) {
    // A malformed tree must be a skip, never reject the whole sync.
    return { ok: false, reason: `could not inspect the tree: ${(err as Error).message}` };
  }
}

function inspectRowChecked(row: AppRow):
  | {
      ok: true;
      manifest: AppManifest;
      entryPath: string;
      clientDir: string;
      wsEntryPath: string | null;
      bakedBase: string | null;
      hasTable: boolean;
    }
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
  // The optional WS entry: dist/server/ws.mjs, emitted by the app's build.
  const wsEntryPath = path.join(row.cwd, 'dist', 'server', 'ws.mjs');
  // What the build says about its own base — the { base, actions } shape
  // every base-aware build emits; the legacy bare array records none.
  let bakedBase: string | null = null;
  let hasTable = false;
  try {
    const table = JSON.parse(
      fs.readFileSync(path.join(row.cwd, 'dist', 'route-table.json'), 'utf8'),
    ) as unknown;
    hasTable = Array.isArray(table) || (typeof table === 'object' && table !== null);
    if (!Array.isArray(table)) {
      const base = (table as { base?: unknown }).base;
      if (typeof base === 'string' && base !== '') bakedBase = base;
    }
  } catch {
    // No table (or unreadable): the base is unknown, not wrong.
  }
  return {
    ok: true,
    manifest: { name: raw.name.trim(), description, slug },
    entryPath,
    clientDir,
    wsEntryPath: fs.existsSync(wsEntryPath) ? wsEntryPath : null,
    bakedBase,
    hasTable,
  };
}

// ---------- fs-watch auto-reload ----------

/** A few hundred ms: a build's file burst settles before one reload fires. */
const WATCH_DEBOUNCE_MS = 300;

/** All the host needs from a watcher handle: close, and errors surfaced. */
export interface AppWatchHandle {
  close(): void;
  onError(listener: (err: Error) => void): void;
}

/** Injectable so the tests can fake fs.watch (error paths, close tracking). */
export type AppWatchFactory = (
  target: string,
  options: { readonly recursive: boolean },
  onChange: () => void,
) => AppWatchHandle;

const nodeWatch: AppWatchFactory = (target, options, onChange) => {
  const watcher = fs.watch(target, options, () => onChange());
  return {
    close: () => watcher.close(),
    onError: listener => watcher.on('error', listener),
  };
};

/** One mounted app's watchers plus its debounced trigger. The cwd watch
 *  (non-recursive) covers app.json edits and dist being replaced whole; the
 *  recursive dist watch covers in-place build output. */
interface AppWatchEntry {
  readonly slug: string;
  readonly fire: (() => void) & { cancel(): void };
  readonly handles: AppWatchHandle[];
  autoReloads: number;
}

// ---------- host ----------

class AppHost {
  private readonly mounted = new Map<string, MountedApp>();
  private skipped: SkippedApp[] = [];
  private booted = false;
  private readonly startedAt = Date.now();
  /** '' at the site root, else the console's base path ('/console'). */
  private readonly base: string;
  /** Serializes reloads; chained as a function so it doesn't start early. */
  private reloadChain: Promise<unknown> = Promise.resolve();
  private importCounter = 0;
  /** slug → watchers; kept in step with `mounted` by doReload. */
  private readonly watchers = new Map<string, AppWatchEntry>();
  private readonly watchFactory: AppWatchFactory;
  private readonly watchEnabled: boolean;
  /** Set by close(); the pending retry sleep is woken and unref'd so a
   *  closed host never holds the process open. */
  private stopped = false;
  private wakeRetry: (() => void) | null = null;
  /** Resolves when the first boot discovery settles, so a later reload()
   *  never races the boot pass. */
  private resolveFirstSync!: () => void;
  readonly firstSync = new Promise<void>(resolve => {
    this.resolveFirstSync = resolve;
  });

  constructor(private readonly deps: AppHostDeps) {
    const base = deps.base ?? readBase();
    this.base = base === '/' ? '' : base;
    this.watchEnabled = deps.watch ?? true;
    this.watchFactory = deps.watchFactory ?? nodeWatch;
  }

  /** The URL prefix an app is mounted (and baked) at. */
  private appBase(slug: string): string {
    return `${this.base}/apps/${slug}`;
  }

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

  stop(): void {
    this.stopped = true;
    this.wakeRetry?.();
    for (const slug of [...this.watchers.keys()]) this.closeWatchEntry(this.watchers.get(slug));
  }

  /** The web server's internal API may not be up yet when the workspace
   *  starts, so retry forever with backoff; rows persist meanwhile. */
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

  /** Throws on transport failure, non-200, or a malformed body. */
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

  /** The query makes each reload a fresh module record so a rebuild is
   *  re-read. ESM can't evict the old one; reloads are rare. */
  private async importHandler(entryPath: string): Promise<AppHandler> {
    const url = pathToFileURL(entryPath);
    url.search = `v=${Date.now()}-${this.importCounter++}`;
    const m: { handler?: unknown } = await import(url.href);
    if (typeof m.handler !== 'function') {
      throw new Error('dist/server/entry.mjs exports no handler function');
    }
    return m.handler as AppHandler;
  }

  /** Same cache-bust as the handler: a rebuilt ws entry is re-read. */
  private async importWsEntry(entryPath: string): Promise<AppUpgradeHandler> {
    const url = pathToFileURL(entryPath);
    url.search = `v=${Date.now()}-${this.importCounter++}`;
    const m: { handleUpgrade?: unknown } = await import(url.href);
    if (typeof m.handleUpgrade !== 'function') {
      throw new Error('dist/server/ws.mjs exports no handleUpgrade function');
    }
    return m.handleUpgrade as AppUpgradeHandler;
  }

  /** A broken ws entry degrades to 503 upgrades, never a skipped mount: the
   *  HTTP face keeps serving the previous build. */
  private async loadWsEntry(
    wsEntryPath: string | null,
  ): Promise<{ upgrade: AppUpgradeHandler | null; upgradeError: string | null }> {
    if (wsEntryPath === null) return { upgrade: null, upgradeError: null };
    try {
      return { upgrade: await this.importWsEntry(wsEntryPath), upgradeError: null };
    } catch (err) {
      const reason = (err as Error).message;
      log.warn(`ws entry failed to import — upgrades answer 503: ${reason}`);
      return { upgrade: null, upgradeError: reason };
    }
  }

  /** A slug scopes the sync to that app. A failed re-import keeps the
   *  previous build serving. */
  async reload(slug: string | null = null): Promise<ReloadReport> {
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
        next.set(row.slug, existing);
        continue;
      }
      const inspected = inspectRow(row);
      if (!inspected.ok) {
        report.skipped.push({ slug: row.slug, reason: inspected.reason });
        continue;
      }
      // The mount and the build must agree on the base, or the app's baked
      // URLs would point outside the console. A disagreement is a skip with
      // the repair named, not a mount serving mysterious 404s.
      const expectedBase = this.appBase(row.slug);
      if (inspected.bakedBase !== null && inspected.bakedBase !== expectedBase) {
        report.skipped.push({
          slug: row.slug,
          reason: `built with base "${inspected.bakedBase}" but this console serves "${expectedBase}" — rebuild the app (the build verb re-bakes the base)`,
        });
        continue;
      }
      if (inspected.bakedBase === null && inspected.hasTable && this.base !== '') {
        report.skipped.push({
          slug: row.slug,
          reason: `its build predates base-aware app builds (dist/route-table.json records no base) and this console serves under "${this.base}" — rebuild the app`,
        });
        continue;
      }
      if (existing) {
        try {
          const handler = await this.importHandler(inspected.entryPath);
          const ws = await this.loadWsEntry(inspected.wsEntryPath);
          next.set(row.slug, { ...existing, handler, ...ws, importedAt: Date.now() });
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
        const ws = await this.loadWsEntry(inspected.wsEntryPath);
        const mounted: MountedApp = {
          slug: row.slug,
          base: this.appBase(row.slug),
          cwd: row.cwd as string,
          manifest: inspected.manifest,
          entryPath: inspected.entryPath,
          clientDir: inspected.clientDir,
          handler,
          upgrade: ws.upgrade,
          upgradeError: ws.upgradeError,
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
        next.set(name, mounted);
        continue;
      }
      report.dropped.push(name);
      log.info(`dropped app mount ${name} (unregistered or incomplete)`);
    }
    this.mounted.clear();
    for (const [name, mounted] of next) this.mounted.set(name, mounted);
    this.skipped = report.skipped;
    this.syncWatchers(report);
    return report;
  }

  /** Watchers follow the registry: armed on mount/re-import (a rebuild may
   *  replace dist/ whole, so re-arm rather than reuse), closed on drop.
   *  A reload still in flight at close() re-arms nothing. */
  private syncWatchers(report: ReloadReport): void {
    if (!this.watchEnabled || this.stopped) return;
    for (const slug of report.dropped) this.closeWatchEntry(this.watchers.get(slug));
    for (const slug of [...report.mounted, ...report.reimported]) {
      const mounted = this.mounted.get(slug);
      if (mounted !== undefined) this.armWatchers(mounted);
    }
  }

  private armWatchers(mounted: MountedApp): void {
    const previous = this.watchers.get(mounted.slug);
    const autoReloads = previous?.autoReloads ?? 0;
    // A trigger still pending against the old handles survives the swap: an
    // event that landed mid-reload must not be lost to the re-arm.
    this.closeWatchEntry(previous, false);
    const fire = debounceTrailing(
      () => this.autoReload(mounted.slug),
      this.deps.watchDebounceMs ?? WATCH_DEBOUNCE_MS,
    );
    const entry: AppWatchEntry = { slug: mounted.slug, fire, handles: [], autoReloads };
    const distDir = path.join(mounted.cwd, 'dist');
    for (const [label, target, recursive] of [
      ['app tree', mounted.cwd, false],
      ['built dist', distDir, true],
    ] as Array<readonly [string, string, boolean]>) {
      try {
        const handle = this.watchFactory(target, { recursive }, fire);
        handle.onError(err => this.watchError(entry, handle, target, err));
        entry.handles.push(handle);
      } catch (err) {
        log.warn(
          `could not watch the ${label} of "${mounted.slug}" (${target}): ` +
            `${(err as Error).message} — reload it by verb instead`,
        );
      }
    }
    if (entry.handles.length > 0) this.watchers.set(mounted.slug, entry);
    else fire.cancel();
  }

  /** A watcher failure (EMFILE, EPERM, a vanished tree) is a logged line,
   *  never a throw: auto-reload for the slug goes quiet until the next
   *  reload re-arms it. */
  private watchError(
    entry: AppWatchEntry,
    handle: AppWatchHandle,
    target: string,
    err: Error,
  ): void {
    log.warn(
      `watcher on ${target} for app "${entry.slug}" failed: ${err.message} — ` +
        'auto-reload is off for it until the next reload',
    );
    handle.close();
    const at = entry.handles.indexOf(handle);
    if (at >= 0) entry.handles.splice(at, 1);
    // An error off a stale generation's handle must not take the current
    // entry down with it.
    if (this.watchers.get(entry.slug) !== entry) return;
    if (entry.handles.length === 0) {
      entry.fire.cancel();
      this.watchers.delete(entry.slug);
    }
  }

  /** cancelPending=false on re-arm: a burst straddling the reload still fires. */
  private closeWatchEntry(entry: AppWatchEntry | undefined, cancelPending = true): void {
    if (entry === undefined) return;
    if (cancelPending) entry.fire.cancel();
    for (const handle of entry.handles) handle.close();
    this.watchers.delete(entry.slug);
  }

  /** One debounced event burst → one scoped reload; reloadChain serializes
   *  whatever overlaps. A failure is logged and leaves the mount standing. */
  private autoReload(slug: string): void {
    if (this.stopped) return;
    const entry = this.watchers.get(slug);
    if (entry === undefined) return; // dropped since the event queued
    entry.autoReloads++;
    log.info(`watch: "${slug}" changed on disk — reloading it`);
    this.reload(slug).catch(err =>
      log.warn(`watch reload of "${slug}" failed: ${(err as Error).message}`),
    );
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
      watch: {
        debounceMs: this.deps.watchDebounceMs ?? WATCH_DEBOUNCE_MS,
        apps: [...this.watchers.values()].map(e => ({ slug: e.slug, autoReloads: e.autoReloads })),
      },
    };
  }

  /** Both shapes address every app: the browser's `<base>/apps/<slug>/…`
   *  (what the web proxy forwards verbatim) and the internal canonical
   *  `/apps/<slug>/…` (the MCP shim, planActionRequest, the tests).
   *  dispatch rewrites the latter onto the mount's base before the app
   *  sees it, so one build serves both. */
  mountFor(url: string): MountedApp | null {
    const base = this.base === '' ? '/apps/' : `${this.base}/apps/`;
    const rest = url.startsWith(base)
      ? url.slice(base.length)
      : url.startsWith('/apps/')
        ? url.slice('/apps/'.length)
        : '';
    if (rest === '') return null;
    return this.mounted.get(rest.split('/')[0] ?? '') ?? null;
  }

  /** Served before the middleware; hashed _astro/ assets are cacheable. */
  serveClientFile(res: http.ServerResponse, m: MountedApp, url: string): boolean {
    const rel = url.slice(m.base.length);
    const file = resolveUnderDir(m.clientDir, rel);
    if (file === null) return false; // traversal
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    sendStaticFile(res, file, rel.startsWith('/_astro/'), res2 => sendText(res2, 404, 'not found'));
    return true;
  }
}

// ---------- listener ----------

export async function startAppHost(deps: AppHostDeps): Promise<AppHostHandle> {
  fs.mkdirSync(path.dirname(deps.socketPath), { recursive: true });
  if (fs.existsSync(deps.socketPath)) {
    const state = await probeSocketFile(deps.socketPath);
    if (state === 'live') throw new AppsSocketOwnedError(deps.socketPath);
    log.info(`removing stale app-host socket ${deps.socketPath}`);
    fs.rmSync(deps.socketPath, { force: true });
  }
  const host = new AppHost(deps);
  /** Live upgrade sockets; close() cuts them so the drain can't hang. */
  const upgradeSockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    hardenResponse(res);
    logAccess(req, res, log);
    dispatch(host, req, res).catch(err => {
      log.error('request handler error', { error: err });
      if (!res.headersSent) sendText(res, 500, 'internal error');
      else res.destroy();
    });
  });
  // WS under /apps/<slug>/…: handed to the mounted app's optional ws entry.
  // The web server's proxy has already run the session/Origin/rate gates.
  server.on('upgrade', (req, socket, head) => {
    upgradeSockets.add(socket);
    socket.on('close', () => upgradeSockets.delete(socket));
    dispatchUpgrade(host, req, socket, head);
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
  const base = deps.base ?? readBase();
  log.info(
    `app host listening on ${deps.socketPath} (0660, base ${base === '/' ? 'at the site root' : base}) — discovering apps via ${deps.internalSocketPath}`,
  );
  host.bootWithRetry();
  await host.firstSync;
  return {
    socketPath: deps.socketPath,
    reload: slug => host.reload(slug ?? null),
    status: () => host.status(),
    close() {
      host.stop();
      for (const socket of upgradeSockets) socket.destroy();
      upgradeSockets.clear();
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

/** `/apps/<slug>/rest` → `<mount.base>/rest` (query kept); URLs already
 *  under the mount's base pass through. One build therefore serves both
 *  addressing shapes: the browser's `<base>/apps/<slug>/…` and the
 *  internal canonical `/apps/<slug>/…`. */
function toMountUrl(m: MountedApp, reqUrl: string): string {
  const root = `/apps/${m.slug}`;
  if (reqUrl === root || reqUrl.startsWith(`${root}/`) || reqUrl.startsWith(`${root}?`)) {
    return m.base + reqUrl.slice(root.length);
  }
  return reqUrl;
}

/** WS entries get the base-independent internal shape `/apps/<slug>/…`
 *  whatever the console's base: a browser upgrade arrives as
 *  `<base>/apps/<slug>/…` (the proxy forwards verbatim) and is stripped
 *  onto the internal shape, which is also what internal callers dial —
 *  a hand-written ws.mjs therefore never depends on the deployment. */
function toWsEntryUrl(m: MountedApp, reqUrl: string): string {
  const root = `/apps/${m.slug}`;
  if (reqUrl === m.base || reqUrl.startsWith(`${m.base}/`) || reqUrl.startsWith(`${m.base}?`)) {
    return root + reqUrl.slice(m.base.length);
  }
  return reqUrl;
}

/** Admin routes, then the app's own HTTP forwarded verbatim. */
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
  // Internal root-shape paths (`/apps/<slug>/…`) are rewritten onto the
  // mount's base — the shape the app was built with. Browser requests
  // already arrive in that shape (the proxy forwards verbatim).
  req.url = toMountUrl(mount, req.url ?? '/');
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (host.serveClientFile(res, mount, (req.url ?? '/').split('?')[0] ?? '/')) return;
  }
  try {
    mount.handler(req, res, err => {
      if (err) {
        log.error(`app ${mount.slug} handler passed an error`, { error: err });
        if (!res.headersSent) sendText(res, 500, 'app error');
        else res.destroy();
        return;
      }
      // next() without an error: the app has no such route.
      sendText(res, 404, 'not found');
    });
  } catch (err) {
    log.error(`app ${mount.slug} handler threw`, { error: err });
    if (!res.headersSent) sendText(res, 500, 'app error');
    else res.destroy();
  }
}

/** Upgrades forward to the mounted app's optional ws entry; everything
 *  else refuses (an upgrade has no res — the status line goes to the socket). */
function dispatchUpgrade(
  host: AppHost,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  // A client reset racing the refusal writes (or the app's own handling)
  // must never surface as an unhandled 'error' — that would kill the host.
  socket.on('error', () => socket.destroy());
  const url = (req.url ?? '').split('?')[0] ?? '/';
  const mount = host.mountFor(url);
  if (mount === null) {
    log.debug(`ws upgrade for an unmounted path: ${url}`);
    socket.write(`HTTP/1.1 404 Not Found\r\n${securityHeaderBlock()}\r\n`);
    socket.destroy();
    return;
  }
  req.url = toWsEntryUrl(mount, req.url ?? '/');
  if (mount.upgrade === null) {
    // An app that ships no ws entry 404s; a broken one 503s (refuse, never hang).
    const status = mount.upgradeError === null ? '404 Not Found' : '503 Service Unavailable';
    if (mount.upgradeError !== null) log.warn(`${mount.slug} ws upgrade: ${mount.upgradeError}`);
    socket.write(`HTTP/1.1 ${status}\r\n${securityHeaderBlock()}\r\n`);
    socket.destroy();
    return;
  }
  log.debug(`ws upgrade for ${mount.slug}: ${url}`);
  try {
    mount.upgrade(req, socket, head);
  } catch (err) {
    log.error(`app ${mount.slug} ws upgrade handler threw`, { error: err });
    socket.destroy();
  }
}

// ---------- entry ----------

/** CYBERMOLE_APPS_SOCK empty: exit 0 (apps off). CYBERMOLE_SOCK empty or a
 *  bad value: exit 1, since there's nothing to discover from. */
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
  const host = await startAppHost({
    socketPath: appsSocket,
    internalSocketPath: internalSocket,
    base: readBase(),
  });
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

// The CJS build's self-exec guard: this file is both a module and an entry.
if (require.main === module) {
  main().catch(err => {
    console.error(`cybermole app-host: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
