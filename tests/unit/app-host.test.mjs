// The app host on a tmp socket against a real internal API, discovering
// synthetic app trees (app.json + a stub entry.mjs; no astro build). The
// registry, reload mount/re-import/drop (the cache bust), per-mount error
// isolation, /_admin/status, the admin body policy, security headers, the
// boot-race retry and the socket lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-host-'));
process.env.CYBERMOLE_TMUX_SOCKET = path.join(dir, 'tmux');

const { startInternalApi } = await import('../../dist-server/server/internal-api.js');
const { startAppHost, AppsSocketOwnedError } = await import('../../dist-server/server/app-host.js');
const { Scheduler } = await import('../../dist-server/src/lib/jobs/jobs.js');
const { StateDb } = await import('../../dist-server/src/lib/platform/db.js');
const { Apps } = await import('../../dist-server/src/lib/apps/apps.js');
const { appsSocketDefault } = await import('../../dist-server/src/lib/platform/env.js');

/** internalApi: false boots the host first (the boot race); call
 *  bootInternalApi() afterwards. A tiny retryDelayMs keeps it fast. */
async function bootWorld({ internalApi = true } = {}) {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const db = new StateDb(path.join(root, 'cybermole.db'));
  const scheduler = new Scheduler(db, { cwd: root, env: {}, logDir: path.join(root, 'job-logs') });
  const apps = new Apps({
    db,
    username: () => ({ ok: true, data: { value: 'unit' } }),
    killSession: async () => true,
  });
  const internalSocket = path.join(root, 'cybermole.sock');
  let api = null;
  if (internalApi) {
    api = await startInternalApi({ socketPath: internalSocket, scheduler, apps });
  }
  const host = await startAppHost({
    socketPath: path.join(root, 'apps.sock'),
    internalSocketPath: internalSocket,
    retryDelayMs: 25,
    discoveryTimeoutMs: 2000,
  });
  return {
    root,
    apps,
    internalSocket,
    api,
    host,
    async bootInternalApi() {
      api = await startInternalApi({ socketPath: internalSocket, scheduler, apps });
      return api;
    },
    get internalApi() {
      return api;
    },
  };
}

/** A middleware-shaped handler. /boom throws, /unmatched and /next-err call
 *  next(); everything else answers MARKER, rewritten between reloads to
 *  check the cache bust. */
function entrySource(marker) {
  return [
    `const marker = ${JSON.stringify(marker)};`,
    'export const handler = (req, res, next) => {',
    "  const url = (req.url || '').split('?')[0];",
    "  if (url.endsWith('/boom')) throw new Error('app blew up');",
    "  if (url.endsWith('/unmatched')) { next(); return; }",
    "  if (url.endsWith('/next-err')) { next(new Error('in-app error')); return; }",
    "  res.writeHead(200, { 'content-type': 'text/plain' });",
    '  res.end(marker);',
    '};',
  ].join('\n');
}

/** opts drop pieces (the skip cases) or override the entry, ws entry and manifest. */
function makeAppTree(root, slug, opts = {}) {
  const cwd = path.join(root, slug);
  fs.mkdirSync(cwd, { recursive: true });
  if (opts.manifest !== null) {
    fs.writeFileSync(
      path.join(cwd, 'app.json'),
      typeof opts.manifest === 'string'
        ? opts.manifest
        : JSON.stringify({
            name: `${slug} app`,
            description: `the ${slug} fixture tree`,
            slug,
          }),
    );
  }
  if (opts.dist !== false) {
    fs.mkdirSync(path.join(cwd, 'dist', 'server'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'dist', 'client', '_astro'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'dist', 'server', 'entry.mjs'),
      opts.entry ?? entrySource(`APP:${slug}:v1`),
    );
    if (opts.wsEntry !== undefined) {
      fs.writeFileSync(path.join(cwd, 'dist', 'server', 'ws.mjs'), opts.wsEntry);
    }
    fs.writeFileSync(path.join(cwd, 'dist', 'client', '_astro', 'app.HASH.css'), 'body{}');
    fs.writeFileSync(path.join(cwd, 'dist', 'client', 'favicon.svg'), '<svg/>');
  }
  return cwd;
}

function call(socketPath, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers:
          body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(body.length) },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body === undefined) req.end();
    else req.end(body);
  });
}

/** body: JSON-serializable, or a raw string. */
const callJson = (socketPath, method, urlPath, body) =>
  call(socketPath, method, urlPath, JSON.stringify(body));

const status = async socketPath =>
  JSON.parse((await call(socketPath, 'GET', '/_admin/status')).text);

// ---------- registry ----------

test('a complete tree mounts: pages through the middleware, assets from dist/client, unknowns 404', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-fixture');
    await w.apps.saveApp('App Fixture', cwd);
    await w.host.reload();

    const page = await call(w.host.socketPath, 'GET', '/apps/app-fixture/some/page');
    assert.equal(page.status, 200);
    assert.equal(page.text, 'APP:app-fixture:v1');

    const hashed = await call(w.host.socketPath, 'GET', '/apps/app-fixture/_astro/app.HASH.css');
    assert.equal(hashed.status, 200);
    assert.equal(hashed.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(hashed.headers['cache-control'], 'public, max-age=3600');

    const favicon = await call(w.host.socketPath, 'GET', '/apps/app-fixture/favicon.svg');
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers['cache-control'], 'no-store');
    assert.equal(favicon.headers['content-type'], 'image/svg+xml');

    const missingAsset = await call(w.host.socketPath, 'GET', '/apps/app-fixture/_astro/nope.css');
    assert.equal(missingAsset.status, 200); // falls through to the middleware (the stub answers)
    assert.equal(missingAsset.text, 'APP:app-fixture:v1');

    const unknownSlug = await call(w.host.socketPath, 'GET', '/apps/ghost/');
    assert.equal(unknownSlug.status, 404);
    assert.equal(JSON.parse(unknownSlug.text).code, 'app_not_mounted');

    const notApp = await call(w.host.socketPath, 'GET', '/somewhere/else');
    assert.equal(notApp.status, 404);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('missing pieces are skipped and reported with a reason, never mounted', async () => {
  const w = await bootWorld();
  try {
    // a console group row: cwd null
    await w.apps.saveApp('Group Only');
    // a cwd without app.json
    const bare = path.join(w.root, 'bare');
    fs.mkdirSync(bare);
    await w.apps.saveApp('Bare', bare);
    // a manifest with no build
    const manifestOnly = makeAppTree(w.root, 'manifest-only', { dist: false });
    await w.apps.saveApp('Manifest Only', manifestOnly);
    // the tree deleted after registration
    const gone = path.join(w.root, 'gone');
    fs.mkdirSync(gone);
    await w.apps.saveApp('Gone', gone);
    fs.rmSync(gone, { recursive: true });

    const report = await w.host.reload();
    assert.equal(report.rows, 4);
    assert.deepEqual(report.mounted, []);
    const bySlug = Object.fromEntries(report.skipped.map(s => [s.slug, s.reason]));
    assert.match(bySlug['group-only'], /row has no cwd \(a console group row/);
    assert.match(bySlug.bare, /app\.json missing/);
    assert.match(bySlug['manifest-only'], /dist\/server\/entry\.mjs missing/);
    assert.match(bySlug.gone, /cwd does not exist/);

    const st = await status(w.host.socketPath);
    assert.equal(st.mounted.length, 0);
    assert.equal(st.skipped.length, 4);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('bad manifests are skipped: unparseable JSON, no name, a slug that disagrees with the row', async () => {
  const w = await bootWorld();
  try {
    const brokenJson = makeAppTree(w.root, 'broken-json', { manifest: '{ nope' });
    await w.apps.saveApp('Broken Json', brokenJson);
    const noName = makeAppTree(w.root, 'no-name', {
      manifest: JSON.stringify({ description: 'nameless' }),
    });
    await w.apps.saveApp('No Name', noName);
    const mismatch = makeAppTree(w.root, 'row-slug', {
      manifest: JSON.stringify({ name: 'X', slug: 'other-slug' }),
    });
    await w.apps.saveApp('Row Slug', mismatch);

    const report = await w.host.reload();
    assert.equal(report.mounted.length, 0);
    const bySlug = Object.fromEntries(report.skipped.map(s => [s.slug, s.reason]));
    assert.match(bySlug['broken-json'], /app\.json is not valid JSON/);
    assert.match(bySlug['no-name'], /name is required/);
    assert.match(bySlug['row-slug'], /does not match the row slug "row-slug"/);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('GET /_admin/status: the shape — pid, uptime, sockets, mounted, skipped', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-fixture');
    await w.apps.saveApp('App Fixture', cwd);
    await w.host.reload();

    const st = await status(w.host.socketPath);
    assert.equal(st.me, 'app-host');
    assert.equal(st.pid, process.pid);
    assert.equal(st.socket, w.host.socketPath);
    assert.equal(st.internalSocket, w.internalSocket);
    assert.equal(st.booted, true);
    assert.ok(st.uptimeS >= 0);
    assert.equal(st.mounted.length, 1);
    assert.deepEqual(st.mounted[0], {
      slug: 'app-fixture',
      base: '/apps/app-fixture',
      cwd,
      name: 'app-fixture app',
      description: 'the app-fixture fixture tree',
      entry: path.join(cwd, 'dist', 'server', 'entry.mjs'),
      importedAt: st.mounted[0].importedAt,
    });
    assert.ok(Number.isInteger(st.mounted[0].importedAt));
    assert.deepEqual(st.skipped, []);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('a half-built tree (entry.mjs without dist/client) is skipped — never the whole surface', async () => {
  const w = await bootWorld();
  try {
    // makeAppTree builds both halves, so build this permutation by hand
    const healthy = makeAppTree(w.root, 'good');
    await w.apps.saveApp('Good', healthy);
    const half = makeAppTree(w.root, 'half-built', { dist: false });
    fs.mkdirSync(path.join(half, 'dist', 'server'), { recursive: true });
    fs.writeFileSync(path.join(half, 'dist', 'server', 'entry.mjs'), entrySource('never'));
    await w.apps.saveApp('Half Built', half);

    const report = await w.host.reload();
    assert.deepEqual(report.mounted, ['good']);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /dist\/client missing/);
    // the healthy sibling serves; the half-built one 404s
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/good/')).status, 200);
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/half-built/')).status, 404);
    // the bad tree never poisons the sync
    const again = await callJson(w.host.socketPath, 'POST', '/_admin/reload', {});
    assert.equal(again.status, 200);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

// ---------- reload ----------

test('reload re-imports a rebuilt entry — the cache-bust', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-fixture');
    await w.apps.saveApp('App Fixture', cwd);
    await w.host.reload();
    assert.equal(
      (await call(w.host.socketPath, 'GET', '/apps/app-fixture/')).text,
      'APP:app-fixture:v1',
    );

    // a rebuild at the same path: without the cache bust, ESM would serve v1
    fs.writeFileSync(
      path.join(cwd, 'dist', 'server', 'entry.mjs'),
      entrySource('APP:app-fixture:v2'),
    );
    const report = await w.host.reload();
    assert.deepEqual(report.reimported, ['app-fixture']);
    assert.deepEqual(report.mounted, []);
    assert.equal(
      (await call(w.host.socketPath, 'GET', '/apps/app-fixture/')).text,
      'APP:app-fixture:v2',
    );
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('a scoped reload {slug} re-imports only that app; the rest carry over', async () => {
  const w = await bootWorld();
  try {
    const a = makeAppTree(w.root, 'alpha');
    const b = makeAppTree(w.root, 'beta');
    await w.apps.saveApp('Alpha', a);
    await w.apps.saveApp('Beta', b);
    await w.host.reload();
    const before = await status(w.host.socketPath);
    const betaBefore = before.mounted.find(m => m.slug === 'beta');

    fs.writeFileSync(path.join(a, 'dist', 'server', 'entry.mjs'), entrySource('APP:alpha:v2'));
    fs.writeFileSync(path.join(b, 'dist', 'server', 'entry.mjs'), entrySource('APP:beta:v2'));

    const report = await w.host.reload('alpha');
    assert.deepEqual(report.reimported, ['alpha']);
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/alpha/')).text, 'APP:alpha:v2');
    // beta wasn't re-imported: still v1
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/beta/')).text, 'APP:beta:v1');
    const after = await status(w.host.socketPath);
    const betaAfter = after.mounted.find(m => m.slug === 'beta');
    assert.equal(betaAfter.importedAt, betaBefore.importedAt);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('reload drops an unregistered app: the row goes, the mount with it', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-fixture');
    await w.apps.saveApp('App Fixture', cwd);
    await w.host.reload();
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/app-fixture/')).status, 200);

    await w.apps.deleteApp('app-fixture');
    const report = await w.host.reload();
    assert.deepEqual(report.dropped, ['app-fixture']);
    const gone = await call(w.host.socketPath, 'GET', '/apps/app-fixture/');
    assert.equal(gone.status, 404);
    assert.equal(JSON.parse(gone.text).code, 'app_not_mounted');
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('reload mounts an app registered after boot (the sync point)', async () => {
  const w = await bootWorld();
  try {
    await w.host.reload(); // empty world
    const cwd = makeAppTree(w.root, 'app-fixture');
    await w.apps.saveApp('App Fixture', cwd);
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/app-fixture/')).status, 404);
    const report = await w.host.reload();
    assert.deepEqual(report.mounted, ['app-fixture']);
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/app-fixture/')).status, 200);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

// ---------- per-mount tolerance ----------

test('a throwing handler is a 500 on that app only; next() paths 404/500; the sibling keeps serving', async () => {
  const w = await bootWorld();
  try {
    const a = makeAppTree(w.root, 'alpha');
    const b = makeAppTree(w.root, 'beta');
    await w.apps.saveApp('Alpha', a);
    await w.apps.saveApp('Beta', b);
    await w.host.reload();

    const boom = await call(w.host.socketPath, 'GET', '/apps/alpha/boom');
    assert.equal(boom.status, 500);

    const unmatched = await call(w.host.socketPath, 'GET', '/apps/alpha/unmatched');
    assert.equal(unmatched.status, 404);

    const nextErr = await call(w.host.socketPath, 'GET', '/apps/alpha/next-err');
    assert.equal(nextErr.status, 500);

    const sibling = await call(w.host.socketPath, 'GET', '/apps/beta/');
    assert.equal(sibling.status, 200);
    assert.equal(sibling.text, 'APP:beta:v1');
    // and the process still answers
    const st = await status(w.host.socketPath);
    assert.equal(st.mounted.length, 2);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('an entry that fails to import is skipped and reported; a failed RE-import keeps the old build serving', async () => {
  const w = await bootWorld();
  try {
    // the entry throws at import
    const poison = makeAppTree(w.root, 'poison', {
      entry: 'throw new Error("broken build");\nexport const handler = () => {};\n',
    });
    await w.apps.saveApp('Poison', poison);
    // no handler export
    const handlerless = makeAppTree(w.root, 'handlerless', {
      entry: 'export const notHandler = 1;\n',
    });
    await w.apps.saveApp('Handlerless', handlerless);
    // a poison rebuild must not take a working mount down
    const good = makeAppTree(w.root, 'good');
    await w.apps.saveApp('Good', good);

    const report = await w.host.reload();
    assert.deepEqual(report.mounted, ['good']);
    const bySlug = Object.fromEntries(report.skipped.map(s => [s.slug, s.reason]));
    assert.match(bySlug.poison, /entry import failed: broken build/);
    assert.match(bySlug.handlerless, /entry import failed: .*no handler/);

    fs.writeFileSync(
      path.join(good, 'dist', 'server', 'entry.mjs'),
      'throw new Error("bad rebuild");\nexport const handler = () => {};\n',
    );
    const rebuilt = await w.host.reload('good');
    assert.deepEqual(rebuilt.reimported, []);
    assert.equal(rebuilt.skipped.filter(s => s.slug === 'good').length, 1);
    assert.match(
      rebuilt.skipped.find(s => s.slug === 'good').reason,
      /re-import failed, previous build still mounted/,
    );
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/good/')).text, 'APP:good:v1');
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

// ---------- admin routes ----------

test('POST /_admin/reload: the report body; GET-only status; unknown admin paths 404', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-fixture');
    await w.apps.saveApp('App Fixture', cwd);
    const r = await callJson(w.host.socketPath, 'POST', '/_admin/reload', {});
    assert.equal(r.status, 200);
    const report = JSON.parse(r.text);
    assert.deepEqual(report, {
      slug: null,
      rows: 1,
      mounted: ['app-fixture'],
      reimported: [],
      dropped: [],
      skipped: [],
    });

    const empty = await call(w.host.socketPath, 'POST', '/_admin/reload');
    assert.equal(empty.status, 200);
    assert.equal(JSON.parse(empty.text).reimported.length, 1);

    const notPost = await call(w.host.socketPath, 'GET', '/_admin/reload');
    assert.equal(notPost.status, 404);
    const notGet = await call(w.host.socketPath, 'POST', '/_admin/status', '');
    assert.equal(notGet.status, 404);
    const unknown = await call(w.host.socketPath, 'GET', '/_admin/nope');
    assert.equal(unknown.status, 404);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('the admin body policy: 411 chunked, 413 oversized, 400 bad JSON, 400 invalid slug', async () => {
  const w = await bootWorld();
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: w.host.socketPath,
          method: 'POST',
          path: '/_admin/reload',
          headers: { 'transfer-encoding': 'chunked' },
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }),
          );
        },
      );
      req.on('error', reject);
      req.end('{}');
    }).then(r => {
      assert.equal(r.status, 411);
      assert.equal(r.json.code, 'length_required');
    });

    const big = await call(
      w.host.socketPath,
      'POST',
      '/_admin/reload',
      JSON.stringify({ slug: 'x'.repeat(11 * 1024) }),
    );
    assert.equal(big.status, 413);
    assert.equal(JSON.parse(big.text).code, 'body_too_large');

    const badJson = await call(w.host.socketPath, 'POST', '/_admin/reload', 'not json');
    assert.equal(badJson.status, 400);
    assert.equal(JSON.parse(badJson.text).code, 'bad_request');

    const badSlug = await callJson(w.host.socketPath, 'POST', '/_admin/reload', { slug: 'NO' });
    assert.equal(badSlug.status, 400);
    assert.equal(JSON.parse(badSlug.text).code, 'invalid_app_slug');
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('security headers ride on every response (handler-set headers win)', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-fixture');
    await w.apps.saveApp('App Fixture', cwd);
    await w.host.reload();
    for (const urlPath of ['/apps/app-fixture/', '/_admin/status', '/apps/ghost/']) {
      const r = await call(w.host.socketPath, 'GET', urlPath);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', urlPath);
      assert.equal(r.headers['x-frame-options'], 'DENY', urlPath);
      assert.ok((r.headers['content-security-policy'] ?? '').startsWith('default-src'), urlPath);
    }
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

// ---------- boot race ----------

test('boot retries until the internal API answers (the compose boot race)', async () => {
  const w = await bootWorld({ internalApi: false });
  try {
    // Rows exist but nothing answers on the internal socket yet; only
    // discovery needs the API.
    const cwd = makeAppTree(w.root, 'app-fixture');
    const apps2 = new Apps({
      db: new StateDb(path.join(w.root, 'cybermole.db')),
      username: () => ({ ok: true, data: { value: 'unit' } }),
      killSession: async () => true,
    });
    const saved = await apps2.saveApp('App Fixture', cwd);
    assert.equal(saved.ok, true);

    const st0 = await status(w.host.socketPath);
    assert.equal(st0.booted, false);
    assert.equal(st0.mounted.length, 0);

    // the web server comes up late; the retry loop picks it up
    await w.bootInternalApi();
    const deadline = Date.now() + 5000;
    for (;;) {
      const st = await status(w.host.socketPath);
      if (st.booted && st.mounted.length === 1) break;
      if (Date.now() > deadline) {
        throw new Error('the host never mounted after the internal API came up');
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await call(w.host.socketPath, 'GET', '/apps/app-fixture/')).status, 200);
  } finally {
    await w.host.close();
    if (w.internalApi) await w.internalApi.close();
  }
});

test('a later internal-API outage: reload answers 503, the registry stands', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-fixture');
    await w.apps.saveApp('App Fixture', cwd);
    await w.host.reload();
    await w.internalApi.close();

    const r = await callJson(w.host.socketPath, 'POST', '/_admin/reload', {});
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).code, 'discovery_failed');

    const page = await call(w.host.socketPath, 'GET', '/apps/app-fixture/');
    assert.equal(page.status, 200);
    assert.equal(page.text, 'APP:app-fixture:v1');
  } finally {
    await w.host.close();
  }
});

test('after listen the socket is 0660; close() unlinks it; a stale file is reclaimed', async () => {
  const w = await bootWorld();
  assert.equal(fs.statSync(w.host.socketPath).mode & 0o777, 0o660);
  await w.host.close();
  await w.internalApi.close();
  assert.equal(fs.existsSync(w.host.socketPath), false);

  // a dead server's leftover file is unlinked and rebound
  fs.writeFileSync(w.host.socketPath, '');
  const again = await startAppHost({
    socketPath: w.host.socketPath,
    internalSocketPath: w.internalSocket,
    retryDelayMs: 25,
  });
  try {
    assert.equal((await call(again.socketPath, 'GET', '/_admin/status')).status, 200);
    assert.equal(fs.statSync(again.socketPath).mode & 0o777, 0o660);
  } finally {
    await again.close();
  }
});

test('a live listener owns the socket: the typed error the supervisor reports', async () => {
  const w = await bootWorld();
  try {
    await assert.rejects(
      startAppHost({
        socketPath: w.host.socketPath,
        internalSocketPath: w.internalSocket,
        retryDelayMs: 25,
      }),
      err => {
        assert.ok(err instanceof AppsSocketOwnedError);
        assert.equal(err.socketPath, w.host.socketPath);
        assert.match(err.message, /another app host owns the socket/);
        return true;
      },
    );
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

// ---------- CYBERMOLE_APPS_SOCK resolution ----------

test('appsSocketDefault: /run/cybermole when the shared dir exists, else the state dir', () => {
  assert.equal(appsSocketDefault('/state', true), '/run/cybermole/apps.sock');
  assert.equal(appsSocketDefault('/state', false), path.join('/state', 'apps.sock'));
});

test('readAppsSocket: empty = off (null), unset = the shape default, absolute wins, relative throws', async () => {
  const { execFileSync } = await import('node:child_process');
  const read = env => {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CYBERMOLE_APPS_SOCK'),
    );
    try {
      const out = execFileSync(
        process.execPath,
        [
          '-e',
          "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/platform/env.js').readAppsSocket()))",
        ],
        { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { value: JSON.parse(out.toString()) };
    } catch (err) {
      return { error: err.stderr.toString() };
    }
  };
  assert.deepEqual(read({ CYBERMOLE_APPS_SOCK: '' }).value, null);
  assert.deepEqual(read({ CYBERMOLE_APPS_SOCK: '   ' }).value, null);
  const stateDir = fs.mkdtempSync(path.join(dir, 'state-'));
  const runCybermole = fs.existsSync('/run/cybermole');
  const expected = runCybermole ? '/run/cybermole/apps.sock' : path.join(stateDir, 'apps.sock');
  assert.equal(read({ CYBERMOLE_STATE_DIR: stateDir }).value, expected);
  assert.equal(read({ CYBERMOLE_APPS_SOCK: '/tmp/apps.sock' }).value, '/tmp/apps.sock');
  const bad = read({ CYBERMOLE_APPS_SOCK: 'apps.sock' });
  assert.match(bad.error, /CYBERMOLE_APPS_SOCK="apps\.sock" must be an absolute socket path/);
});

// ---------- WS upgrade dispatch ----------

/** A ws entry that answers 101 with its marker and echoes `marker:` + bytes;
 *  /unrouted refuses app-side (the app is the router). */
function wsEntrySource(marker) {
  return [
    `const marker = ${JSON.stringify(marker)};`,
    'export function handleUpgrade(req, socket, head) {',
    "  const url = (req.url || '').split('?')[0];",
    "  if (url.endsWith('/unrouted')) {",
    "    socket.write('HTTP/1.1 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n');",
    '    socket.destroy();',
    '    return;',
    '  }',
    '  socket.write(`HTTP/1.1 101 Switching Protocols\\r\\nX-Marker: ${marker}\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n`);',
    "  socket.on('data', d => socket.write(marker + ':' + d));",
    '}',
  ].join('\n');
}

/** A raw upgrade dial against the host's socket: resolves the 101 (+socket)\n *  or the refusal status. */
function rawUpgrade(socketPath, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      },
      res => {
        resolve({ status: res.statusCode });
        res.destroy();
      },
    );
    req.on('upgrade', (res, socket) =>
      resolve({ status: res.statusCode, marker: res.headers['x-marker'], socket }),
    );
    req.on('error', reject);
    req.end();
  });
}

test('an app with a ws entry: upgrades reach it, verbatim path; without one they 404', async () => {
  const w = await bootWorld();
  try {
    const withWs = makeAppTree(w.root, 'app-ws', { wsEntry: wsEntrySource('WS:v1') });
    await w.apps.saveApp('App WS', withWs);
    const withoutWs = makeAppTree(w.root, 'app-nows');
    await w.apps.saveApp('App NoWS', withoutWs);
    await w.host.reload();

    // Through the ws entry: 101 + a raw echo round trip.
    const up = await rawUpgrade(w.host.socketPath, '/apps/app-ws/ws?x=1');
    assert.equal(up.status, 101);
    assert.equal(up.marker, 'WS:v1');
    const echoed = await new Promise((resolve, reject) => {
      up.socket.on('data', d => resolve(String(d)));
      up.socket.on('error', reject);
      up.socket.write('ping');
    });
    assert.equal(echoed, 'WS:v1:ping');
    up.socket.destroy();

    // The app routes its own paths (its own 404 forwards verbatim).
    const unrouted = await rawUpgrade(w.host.socketPath, '/apps/app-ws/unrouted');
    assert.equal(unrouted.status, 404);

    // No ws entry: the app's upgrades 404; unmounted slugs the same.
    const nows = await rawUpgrade(w.host.socketPath, '/apps/app-nows/ws');
    assert.equal(nows.status, 404);
    const ghost = await rawUpgrade(w.host.socketPath, '/apps/ghost/ws');
    assert.equal(ghost.status, 404);

    // The HTTP face is unaffected.
    const page = await call(w.host.socketPath, 'GET', '/apps/app-ws/page');
    assert.equal(page.status, 200);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('a broken ws entry degrades to 503 upgrades, never a skipped mount', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-badws', { wsEntry: 'export const notAHook = 1;' });
    await w.apps.saveApp('App BadWS', cwd);
    await w.host.reload();
    const statusBody = await status(w.host.socketPath);
    assert.ok(
      statusBody.mounted.some(m => m.slug === 'app-badws'),
      'the app still mounts',
    );

    const refused = await rawUpgrade(w.host.socketPath, '/apps/app-badws/ws');
    assert.equal(refused.status, 503);
    const page = await call(w.host.socketPath, 'GET', '/apps/app-badws/page');
    assert.equal(page.status, 200);
  } finally {
    await w.host.close();
    await w.internalApi.close();
  }
});

test('reload re-imports a rebuilt ws entry (the cache-bust); close() cuts live upgrade sockets', async () => {
  const w = await bootWorld();
  try {
    const cwd = makeAppTree(w.root, 'app-reload', { wsEntry: wsEntrySource('WS:v1') });
    await w.apps.saveApp('App Reload', cwd);
    await w.host.reload();
    const first = await rawUpgrade(w.host.socketPath, '/apps/app-reload/ws');
    assert.equal(first.marker, 'WS:v1');
    first.socket.destroy();

    fs.writeFileSync(path.join(cwd, 'dist', 'server', 'ws.mjs'), wsEntrySource('WS:v2'));
    await w.host.reload();
    const second = await rawUpgrade(w.host.socketPath, '/apps/app-reload/ws');
    assert.equal(second.marker, 'WS:v2');

    // The drain cannot hang on a live upgrade socket: close() cuts it, and
    // the client sees the cut.
    const cut = new Promise(resolve => second.socket.once('close', resolve));
    const t0 = Date.now();
    await w.host.close();
    assert.ok(Date.now() - t0 < 5000, `close took ${Date.now() - t0}ms`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client socket not cut by close()')), 2000);
      cut.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await w.internalApi.close();
    return;
  } finally {
    try {
      await w.host.close();
    } catch {
      /* closed in-case */
    }
    await w.internalApi.close();
  }
});
