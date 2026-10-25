// apps-proxy.test.mjs — task/app-web (docs/plans/apps-plan.md §4) units: the
// /apps/* proxy's decision surface and transport, exercised over REAL
// sockets without the console — a stub "app host" on a tmp-dir unix
// socket, and a "web side" http server whose handler is exactly the
// branch server/main.ts mounts (handleAppsRequest). Covers: the path
// matchers, the off-surface 404 namespace, unknown-slug 404 BEFORE any
// socket is touched, the verbatim forward (method/path/headers/body),
// the session cookie NOT forwarded (plan §8 — an app has exactly a
// terminal's powers), the body cap policy, host-down 502 fast, a wedged
// host 502 after the (injectable) idle timeout, and the unreadable-db
// 503.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-apps-proxy-'));

const { handleAppsRequest, isAppsHttpPath, appsSlugOf, APPS_BODY_MAX_BYTES } =
  await import('../../dist-server/src/lib/apps-proxy.js');

// ---------- the stub app host (what server/app-host.js stands in as) ----------

/** An echoing app host: every /apps/fixture/* answer is a JSON echo of
 *  the request (method, path, headers, body) so the tests can assert
 *  VERBATIM forwarding. `wedged` accepts and never answers. */
function stubHost(socketPath) {
  const seen = { connections: 0, requests: [] };
  const server = http.createServer((req, res) => {
    seen.requests.push(req.url);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/apps/fixture/wedged') return; // accepted, never answers
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Stub-Host': 'yes' });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          cookie: req.headers.cookie ?? null,
          contentType: req.headers['content-type'] ?? null,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
  });
  server.on('connection', () => seen.connections++);
  return {
    seen,
    listen: () =>
      new Promise(resolve => {
        fs.mkdirSync(path.dirname(socketPath), { recursive: true });
        server.listen(socketPath, resolve);
      }),
    close: () =>
      new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------- the web side under test: handleAppsRequest as main.ts mounts it ----------

let webServer;
let webPort;
const registeredSlugs = new Set(['fixture']); // the db stand-in
let dbReadable = true;
const bootWeb = async deps => {
  webServer = http.createServer((req, res) => handleAppsRequest(deps, req, res));
  await new Promise(resolve => {
    webServer.listen(0, '127.0.0.1', resolve);
  });
  webPort = webServer.address().port;
};
const webUrl = p => `http://127.0.0.1:${webPort}${p}`;

/** A raw request against the web side (fetch, plus the chunked case
 *  fetch cannot make: node http without a Content-Length sends chunked). */
function rawRequest(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(webUrl(p), { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body === undefined) req.end();
    else req.end(body);
  });
}

const baseDeps = (socketPath, extra = {}) => ({
  base: '/',
  socketPath,
  registered: slug => (dbReadable ? registeredSlugs.has(slug) : null),
  ...extra,
});

test('isAppsHttpPath / appsSlugOf: the namespace and its slug segment', () => {
  assert.equal(isAppsHttpPath('/', '/apps'), true);
  assert.equal(isAppsHttpPath('/', '/apps/a/b'), true);
  assert.equal(isAppsHttpPath('/', '/appsylvania'), false);
  assert.equal(isAppsHttpPath('/foo', '/foo/apps/a'), true);
  assert.equal(isAppsHttpPath('/foo', '/apps/a'), false);
  assert.equal(appsSlugOf('/', '/apps/fixture/x?q'), 'fixture');
  assert.equal(appsSlugOf('/', '/apps/fixture'), 'fixture');
  assert.equal(appsSlugOf('/', '/apps'), null);
  assert.equal(appsSlugOf('/', '/apps/'), null);
  assert.equal(appsSlugOf('/', '/other'), null);
});

test('off surface (CYBERMOLE_APPS_SOCK empty): the whole /apps/* namespace answers the Result-JSON 404', async () => {
  const host = stubHost(path.join(dir, 'off.sock'));
  await host.listen();
  await bootWeb(baseDeps(null));
  try {
    for (const p of ['/apps', '/apps/', '/apps/fixture/', '/apps/fixture/api/ping']) {
      const r = await rawRequest('GET', p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(r.json, { error: 'not found', detail: null, code: 'not_found' }, p);
    }
    assert.equal(host.seen.connections, 0, 'the host is never touched');
  } finally {
    await host.close();
    webServer.close();
  }
});

test('unknown slug: 404 before ever touching the host; a bad slug is the same 404', async () => {
  const host = stubHost(path.join(dir, 'host.sock'));
  await host.listen();
  await bootWeb(baseDeps(path.join(dir, 'host.sock')));
  try {
    const r = await rawRequest('GET', '/apps/never-registered/');
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'not found', detail: null, code: 'not_found' });
    // A %-escape mess in the slug segment is not an APP_SLUG_RE slug: the
    // same unknown-slug 404, never a throw.
    const bad = await rawRequest('GET', '/apps/%E0%80/sub');
    assert.equal(bad.status, 404);
    assert.equal(host.seen.requests.length, 0, 'the host is never touched');
  } finally {
    await host.close();
    webServer.close();
  }
});

test('registered slug: forwarded verbatim — method, path, body, headers minus hop-by-hop and the session cookie', async () => {
  const host = stubHost(path.join(dir, 'host2.sock'));
  await host.listen();
  await bootWeb(baseDeps(path.join(dir, 'host2.sock')));
  try {
    const page = await rawRequest('GET', '/apps/fixture/some/page?x=1');
    assert.equal(page.status, 200);
    assert.equal(page.headers['x-stub-host'], 'yes');
    assert.equal(page.json.method, 'GET');
    assert.equal(page.json.url, '/apps/fixture/some/page?x=1');

    const posted = await rawRequest('POST', '/apps/fixture/api/ping', {
      headers: { 'content-type': 'application/json', cookie: 'cybermole_session=SEKRET' },
      body: '{"name":"world"}',
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.method, 'POST');
    assert.equal(posted.json.body, '{"name":"world"}');
    assert.equal(posted.json.contentType, 'application/json');
    // plan §8: the console's session token must never become app-visible.
    assert.equal(posted.json.cookie, null, 'the session cookie is NOT forwarded');

    // The exact-slug form (/apps/<slug>, no trailing slash) forwards
    // verbatim too — the app's baked-base behavior answers it (verified
    // against the fixture: no redirect synthesized).
    const exact = await rawRequest('GET', '/apps/fixture');
    assert.equal(exact.status, 200);
    assert.equal(exact.json.url, '/apps/fixture');
  } finally {
    await host.close();
    webServer.close();
  }
});

test('host down (nothing on the socket): 502 fast, one-line body', async () => {
  const dead = path.join(dir, 'dead.sock'); // never listened
  await bootWeb(baseDeps(dead));
  try {
    const started = Date.now();
    const r = await rawRequest('GET', '/apps/fixture/');
    const took = Date.now() - started;
    assert.equal(r.status, 502);
    assert.equal(r.text, 'app host unavailable');
    assert.ok(took < 2000, `502 answered fast (took ${took}ms)`);
  } finally {
    webServer.close();
  }
});

test('wedged host (accepts, never answers): 502 after the idle timeout, never a hang', async () => {
  const host = stubHost(path.join(dir, 'wedged.sock'));
  await host.listen();
  await bootWeb(baseDeps(path.join(dir, 'wedged.sock'), { idleTimeoutMs: 150 }));
  try {
    const started = Date.now();
    const r = await rawRequest('GET', '/apps/fixture/wedged');
    const took = Date.now() - started;
    assert.equal(r.status, 502);
    assert.equal(r.text, 'app host unavailable');
    assert.ok(took >= 140 && took < 2000, `the idle timeout fired (took ${took}ms)`);
  } finally {
    await host.close();
    webServer.close();
  }
});

test('body policy: 413 over the cap, 411 for a length-less chunked body — before the host is touched', async () => {
  const host = stubHost(path.join(dir, 'cap.sock'));
  await host.listen();
  await bootWeb(baseDeps(path.join(dir, 'cap.sock')));
  try {
    const over = await rawRequest('POST', '/apps/fixture/api/x', {
      body: 'x'.repeat(APPS_BODY_MAX_BYTES + 1),
    });
    assert.equal(over.status, 413);

    // node http without a Content-Length sends chunked — the console's
    // 411 stance.
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request(
        webUrl('/apps/fixture/api/x'),
        {
          method: 'POST',
          headers: { 'transfer-encoding': 'chunked' },
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end('hello');
    });
    assert.equal(chunked.status, 411);
    assert.equal(host.seen.requests.length, 0, 'the host is never touched');
  } finally {
    await host.close();
    webServer.close();
  }
});

test('unreadable state db: fail closed with 503, like the session store', async () => {
  const host = stubHost(path.join(dir, 'db.sock'));
  await host.listen();
  dbReadable = false;
  await bootWeb(baseDeps(path.join(dir, 'db.sock')));
  try {
    const r = await rawRequest('GET', '/apps/fixture/');
    assert.equal(r.status, 503);
    assert.equal(host.seen.requests.length, 0);
  } finally {
    dbReadable = true;
    await host.close();
    webServer.close();
  }
});
