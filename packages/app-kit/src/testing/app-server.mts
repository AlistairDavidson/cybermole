// The per-app e2e harness: the app-side twin of the console's hermetic
// tests/e2e pattern (tests/support/global-setup.ts). Boots an app's BUILT
// dist/server/entry.mjs — the @astrojs/node middleware handler the app host
// mounts (server/app-host.ts) — on an ephemeral loopback HTTP server,
// serving dist/client files first and the handler second, exactly like the
// host. HTTP only: an app's optional WS entry is not mounted (that face is
// the console's own apps-ws spec's job).
//
// The per-run temp dir is the app's hermeticity: CYBERMOLE_APP_DATA_DIR
// (appDataDir) points the built handler's data at <dir>/data, so a run
// never touches the tree's real data/. One app per process — the override
// travels through the env.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DATA_DIR_ENV, appRootFrom } from './app-tree.mjs';

/** The @astrojs/node middleware export (apps get no locals — same as the
 *  app host's mount). */
type AppHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (err?: unknown) => void,
) => void;

export interface AppServer {
  /** e.g. http://127.0.0.1:54321 */
  readonly origin: string;
  /** the base baked in at build: /apps/<slug> */
  readonly base: string;
  /** origin + base — what specs navigate */
  readonly baseURL: string;
  /** the per-run hermetic dir; the app's data lands in <dir>/data */
  readonly dir: string;
  close(): Promise<void>;
}

export interface StartAppServerOptions {
  /** Any file or dir inside the app tree; the walk-up to app.json finds
   *  the root (a spec passes import.meta.url). */
  from?: URL | string;
  /** The app tree directly (app.json + dist/). Default: above cwd. */
  appRoot?: string;
  /** The hermetic per-run dir. Default: a fresh mkdtemp under os.tmpdir(). */
  dir?: string;
  /** Default 127.0.0.1. */
  host?: string;
}

export async function startAppServer(options: StartAppServerOptions = {}): Promise<AppServer> {
  const appRoot =
    options.appRoot ?? appRootFrom(options.from !== undefined ? options.from : process.cwd());
  const entry = path.join(appRoot, 'dist', 'server', 'entry.mjs');
  const clientDir = path.join(appRoot, 'dist', 'client');
  if (!fs.existsSync(entry))
    throw new Error(`${entry} is missing — build the app first (npm run build)`);
  if (!fs.existsSync(clientDir))
    throw new Error(`${clientDir} is missing — build the app first (npm run build)`);

  const slug = readSlug(appRoot);
  const base = `/apps/${slug}`;
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `${slug}-e2e-`));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const previousDataDir = process.env[APP_DATA_DIR_ENV];
  process.env[APP_DATA_DIR_ENV] = path.join(dir, 'data');

  // The same cache-bust as the app host: a fresh module record per boot.
  const entryUrl = pathToFileURL(entry);
  entryUrl.search = `v=${Date.now()}`;
  const mod = (await import(entryUrl.href)) as { handler?: unknown };
  if (typeof mod.handler !== 'function') throw new Error(`${entry} exports no handler function`);
  const handler = mod.handler as AppHandler;

  const server = http.createServer((req, res) => {
    harden(res);
    try {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      if (pathname !== base && !pathname.startsWith(`${base}/`)) {
        send(res, 404, `not an app path: ${pathname} (this server serves ${base}/ only)`);
        return;
      }
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        serveClientFile(res, clientDir, base, pathname)
      )
        return;
      handler(req, res, err => {
        if (err) {
          if (!res.headersSent) send(res, 500, `app error: ${(err as Error).message}`);
          else res.destroy();
          return;
        }
        send(res, 404, 'not found');
      });
    } catch (err) {
      if (!res.headersSent) send(res, 500, `harness error: ${(err as Error).message}`);
      else res.destroy();
    }
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the ephemeral listener reported no port');
  const origin = `http://${host}:${address.port}`;

  return {
    origin,
    base,
    baseURL: `${origin}${base}`,
    dir,
    async close() {
      // Keep-alive sockets would hold the close open; cut them first.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())),
      );
      if (previousDataDir === undefined)
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- returning the env we borrowed (computed key: the kit's own constant)
        delete process.env[APP_DATA_DIR_ENV];
      else process.env[APP_DATA_DIR_ENV] = previousDataDir;
    },
  };
}

/** The slug is the only base source here (no db row): the scaffold bakes
 *  base '/apps/<slug>' from app.json's slug. */
function readSlug(appRoot: string): string {
  const manifest = path.join(appRoot, 'app.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (err) {
    throw new Error(`could not read ${manifest}: ${(err as Error).message}`);
  }
  const slug = (parsed as { slug?: unknown }).slug;
  if (typeof slug !== 'string' || slug.trim() === '')
    throw new Error(`${manifest} has no slug — the baked base cannot be derived`);
  return slug;
}

// The host's own response rules, kept in step with server/app-host.ts so an
// app-side e2e run sees the headers the real mount would add.
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

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' wss:; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

function send(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Fills in absent security headers at writeHead or end. */
function harden(res: http.ServerResponse): void {
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

/** Served before the middleware; hashed _astro/ assets are cacheable.
 *  Returns false when the file isn't there (the handler answers then). */
function serveClientFile(
  res: http.ServerResponse,
  clientDir: string,
  base: string,
  pathname: string,
): boolean {
  const rel = pathname.slice(base.length);
  const file = path.normalize(path.join(clientDir, rel));
  if (!file.startsWith(clientDir + path.sep)) return false; // traversal
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, 'not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': rel.startsWith('/_astro/') ? 'public, max-age=3600' : 'no-store',
    });
    res.end(data);
  });
  return true;
}
