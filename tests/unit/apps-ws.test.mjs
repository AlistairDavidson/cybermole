// The /apps/* WS upgrade tunnel over real sockets: a stub app host on a tmp
// socket (a real ws server) and a web-side server running the same wiring
// main.ts mounts — checkEventsUpgrade (the shared gate) then
// handleAppsUpgrade. The gate's own branches live in events-ws.test.mjs;
// here it's the apps wiring: refusals as status lines/destroys, slug and
// registry resolution before any socket is touched, cookie-stripped verbatim
// forwarding, host-down and wedged-host 502s, teardown both ways, the
// token-expiry sweep, and the tracker integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-apps-ws-'));

const { handleAppsUpgrade, appsUpgradeHeaders } =
  await import('../../dist-server/src/lib/apps/apps-ws.js');
const { checkEventsUpgrade } = await import('../../dist-server/src/lib/platform/events-ws.js');
const { TunnelTracker } = await import('../../dist-server/src/lib/platform/ws-tunnels.js');

const TOKEN = 'tok-1';
const noSession = {
  ok: false,
  resultType: 'session_check',
  errorCode: 'no_session',
  errorMessage: 'no such session',
};
const session = { ok: true, resultType: 'session_check', data: { token: TOKEN } };

const log = { info() {}, warn() {}, error() {}, debug() {} };

// ---------- stub app host (a real ws echo server on a unix socket) ----------

function stubHost(socketPath) {
  const seen = { upgrades: [], cookies: [] };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const server = http.createServer((_req, res) => {
    res.destroy();
  });
  /** Resolves once the tunnel's upstream socket has closed. */
  let noteUpstreamClosed = () => undefined;
  const upstreamClosed = new Promise(resolve => {
    noteUpstreamClosed = resolve;
  });
  let upstreamCount = 0;
  /** Upgraded sockets are off the server's connection books — close() must
   *  destroy them itself (the app host tracks them the same way). */
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    seen.upgrades.push(req.url);
    seen.cookies.push(req.headers.cookie ?? null);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if ((req.url ?? '').split('?')[0] === '/apps/fixture/wedged') return; // accepted, never answers
    upstreamCount++;
    socket.on('close', () => {
      upstreamCount--;
      if (upstreamCount === 0) noteUpstreamClosed();
    });
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', data => ws.send(data));
    });
  });
  return {
    seen,
    upstreamClosed,
    listen: () =>
      new Promise(resolve => {
        fs.mkdirSync(path.dirname(socketPath), { recursive: true });
        server.listen(socketPath, resolve);
      }),
    close: () =>
      new Promise(resolve => {
        wss.close(() => undefined);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------- web side under test (main.ts's wiring) ----------

let webServer;
let webPort;
let currentSocketPath = null;
const registeredSlugs = new Set(['fixture']);
let dbReadable = true;
let tokenAlive = true;
let limited = false;
const tunnels = new TunnelTracker();
const gateChecks = {
  shuttingDown: () => false,
  allow: () => !limited,
  originOk: req => req.headers.origin === 'http://web.test',
  validSession: cookie => (cookie === `cybermole_session=${TOKEN}` ? session : noSession),
};

const wiredDeps = socketPath => ({
  base: '/',
  socketPath,
  registered: slug => (dbReadable ? registeredSlugs.has(slug) : null),
  securityHeaders: 'X-Test: gated\r\n',
  track: (token, t) => tunnels.track(token, t),
  untrack: (token, t) => tunnels.untrack(token, t),
  alive: () => (tokenAlive ? session : noSession),
  log,
  sweepMs: 40,
  idleTimeoutMs: 120,
});

const bootWeb = async socketPath => {
  currentSocketPath = socketPath;
  webServer = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  // The upgrade branch exactly as main.ts mounts it.
  webServer.on('upgrade', (req, socket, head) => {
    const gate = checkEventsUpgrade(req, '127.0.0.1', gateChecks);
    handleAppsUpgrade({ ...wiredDeps(currentSocketPath), gate }, req, socket, head);
  });
  await new Promise(resolve => {
    webServer.listen(0, '127.0.0.1', resolve);
  });
  webPort = webServer.address().port;
};

const wsUrl = p => `ws://127.0.0.1:${webPort}${p}`;

/** A raw upgrade dial: resolves the first response (status line) or 101. */
function rawUpgrade(p, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(wsUrl(p).replace('ws', 'http'), {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        origin: 'http://web.test',
        cookie: `cybermole_session=${TOKEN}`,
        ...headers,
      },
    });
    req.on('response', res => {
      resolve({ status: res.statusCode, headers: res.headers });
      res.destroy();
    });
    req.on('upgrade', (res, socket) => {
      resolve({ status: res.statusCode, socket });
    });
    req.on('error', reject);
    req.end();
  });
}

/** A ws client through the tunnel, with the session cookie attached. */
function wsClient(p = '/apps/fixture/ws') {
  return new WebSocket(wsUrl(p), {
    headers: { origin: 'http://web.test', cookie: `cybermole_session=${TOKEN}` },
  });
}

const within = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);

const closeWeb = () =>
  new Promise(resolve => {
    webServer.close(() => resolve());
    webServer.closeAllConnections();
  });

// ---------- pure: the forwarded handshake headers ----------

test('appsUpgradeHeaders: hop-by-hop stripped and re-added, the cookie never reaches the app', () => {
  const h = appsUpgradeHeaders({
    host: 'console.test',
    connection: 'keep-alive, Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': 'k',
    cookie: 'cybermole_session=secret',
    'x-custom': 'kept',
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
  });
  assert.equal(h.connection, 'Upgrade');
  assert.equal(h.upgrade, 'websocket');
  assert.equal(h.cookie, undefined);
  assert.equal(h['keep-alive'], undefined);
  assert.equal(h['transfer-encoding'], undefined);
  assert.equal(h['x-custom'], 'kept');
  assert.equal(h['sec-websocket-key'], 'k');
});

test('appsUpgradeHeaders: a missing upgrade token defaults to websocket', () => {
  const h = appsUpgradeHeaders({ host: 'x' });
  assert.equal(h.upgrade, 'websocket');
});

// ---------- the tunnel, end to end ----------

test('a gated upgrade tunnels to the app: echo round trip, path verbatim, no cookie', async () => {
  const host = stubHost(path.join(dir, 'host.sock'));
  await host.listen();
  await bootWeb(path.join(dir, 'host.sock'));
  const ws = wsClient('/apps/fixture/ws?x=1');
  try {
    const echoed = await within(
      new Promise((resolve, reject) => {
        ws.on('open', () => ws.send('hello through the tunnel'));
        ws.on('message', data => resolve(String(data)));
        ws.on('error', reject);
      }),
      5000,
      'echo',
    );
    assert.equal(echoed, 'hello through the tunnel');
    assert.deepEqual(host.seen.upgrades, ['/apps/fixture/ws?x=1']);
    assert.deepEqual(host.seen.cookies, [null], 'the session cookie is stripped');
  } finally {
    ws.close();
    await host.close();
    await closeWeb();
  }
});

test('gate refusals through the wiring: no session 401s, rate-limit and bad Origin destroy', async () => {
  const host = stubHost(path.join(dir, 'gate.sock'));
  await host.listen();
  await bootWeb(path.join(dir, 'gate.sock'));
  try {
    // No cookie: the gate answers a status line (plus the security block).
    const noCookie = await rawUpgrade('/apps/fixture/ws', { headers: { cookie: '' } });
    assert.equal(noCookie.status, 401);
    assert.equal(noCookie.headers['x-test'], 'gated');

    // Rate-limited: destroyed before any HTTP answer.
    limited = true;
    await assert.rejects(within(rawUpgrade('/apps/fixture/ws'), 500, 'rate-limited'));
    limited = false;

    // Mismatched Origin: destroyed silently.
    await assert.rejects(
      within(
        rawUpgrade('/apps/fixture/ws', { headers: { origin: 'http://evil.test' } }),
        500,
        'origin',
      ),
    );
    assert.equal(host.seen.upgrades.length, 0, 'the host is never touched');
  } finally {
    await host.close();
    await closeWeb();
  }
});

test('slug resolution: unknown slug 404s before touching the host, unreadable db 503s', async () => {
  const host = stubHost(path.join(dir, 'slug.sock'));
  await host.listen();
  await bootWeb(path.join(dir, 'slug.sock'));
  try {
    const unknown = await rawUpgrade('/apps/never-registered/ws');
    assert.equal(unknown.status, 404);
    const bad = await rawUpgrade('/apps/%E0%80/ws');
    assert.equal(bad.status, 404);
    dbReadable = false;
    const unreadable = await rawUpgrade('/apps/fixture/ws');
    assert.equal(unreadable.status, 503);
    dbReadable = true;
    assert.equal(host.seen.upgrades.length, 0, 'the host is never touched');
  } finally {
    await host.close();
    await closeWeb();
  }
});

test('apps off: the upgrade namespace refuses 404 like the HTTP proxy', async () => {
  await bootWeb(null);
  try {
    const r = await rawUpgrade('/apps/fixture/ws');
    assert.equal(r.status, 404);
  } finally {
    await closeWeb();
  }
});

test('a down host refuses fast with 502; a wedged host 502s at the idle cap', async () => {
  // Down: nothing listens at the path — the refusal is immediate, never a hang.
  await bootWeb(path.join(dir, 'missing.sock'));
  const started = Date.now();
  const downAns = await rawUpgrade('/apps/fixture/ws');
  assert.equal(downAns.status, 502);
  assert.ok(Date.now() - started < 2000, `refused in ${Date.now() - started}ms`);
  await closeWeb();

  // Wedged: accepts the upgrade request, never answers 101.
  const host = stubHost(path.join(dir, 'wedged.sock'));
  await host.listen();
  await bootWeb(path.join(dir, 'wedged.sock'));
  try {
    const wedged = await within(rawUpgrade('/apps/fixture/wedged'), 5000, 'wedged 502');
    assert.equal(wedged.status, 502);
    assert.equal(host.seen.upgrades.length, 1);
  } finally {
    await host.close();
    await closeWeb();
  }
});

test('teardown both ways: a client close reaches the app, an app close reaches the client', async () => {
  const host = stubHost(path.join(dir, 'teardown.sock'));
  await host.listen();
  await bootWeb(path.join(dir, 'teardown.sock'));
  try {
    // Client side closes: the app host sees its end go too.
    const ws = wsClient();
    await within(new Promise(r => ws.on('open', r)), 5000, 'open');
    ws.close();
    await within(host.upstreamClosed, 5000, 'client close reaches the app');

    // Upstream side closes: the app host dies, the tunnel carries it to the client.
    const ws2 = wsClient();
    await within(new Promise(r => ws2.on('open', r)), 5000, 'open 2');
    const sawClose = new Promise(r => ws2.on('close', r));
    await host.close();
    await within(sawClose, 5000, 'upstream close reaches the client');
    assert.equal(tunnels.count(), 0, 'the tunnel is untracked on close');
  } finally {
    try {
      await host.close();
    } catch {
      /* already closed in-case */
    }
    await closeWeb();
  }
});

test('a dead token cuts the tunnel on the next sweep (WS traffic never renews it)', async () => {
  const host = stubHost(path.join(dir, 'sweep.sock'));
  await host.listen();
  await bootWeb(path.join(dir, 'sweep.sock'));
  try {
    const ws = wsClient();
    await within(new Promise(r => ws.on('open', r)), 5000, 'open');
    assert.equal(tunnels.count(), 1);
    const closed = new Promise(r => ws.on('close', r));
    tokenAlive = false;
    await within(closed, 5000, 'sweep closes the tunnel');
    assert.equal(tunnels.count(), 0);
  } finally {
    tokenAlive = true;
    await host.close();
    await closeWeb();
  }
});

test('logout wiring: closeToken cuts every tunnel of the token', async () => {
  const host = stubHost(path.join(dir, 'logout.sock'));
  await host.listen();
  await bootWeb(path.join(dir, 'logout.sock'));
  try {
    const a = wsClient();
    const b = wsClient();
    await within(
      Promise.all([new Promise(r => a.on('open', r)), new Promise(r => b.on('open', r))]),
      5000,
      'opens',
    );
    assert.equal(tunnels.count(), 2);
    const closed = Promise.all([
      new Promise(r => a.on('close', r)),
      new Promise(r => b.on('close', r)),
    ]);
    tunnels.closeToken(TOKEN);
    await within(closed, 5000, 'both cut');
    assert.equal(tunnels.count(), 0);
  } finally {
    await host.close();
    await closeWeb();
  }
});
