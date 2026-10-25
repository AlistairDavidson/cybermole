// services.appsStatus (GET /api/apps/status): the builder page's portfolio
// join — shape (rows × mounted × built/stale, plus unregistered trees) and
// the ~10 s cache that keeps the 15 s poll off the fs.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateDb } from '../../dist-server/src/lib/platform/db.js';
import { Apps } from '../../dist-server/src/lib/apps/apps.js';
import { createServices } from '../../dist-server/src/lib/platform/services.js';

const USERNAME = { ok: true, resultType: 'database_read', data: { value: 'tester' } };

function freshDb() {
  return new StateDb(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-status-')), 'cybermole.db'),
  );
}

/** createServices with only what appsStatus touches; the rest are stubs. */
function services(db, appsRoot, serving, now) {
  return createServices({
    cfg: {
      host: '127.0.0.1',
      port: 1980,
      base: '/',
      home: '/tmp',
      agentDir: '/tmp',
      dbFile: 'unused',
      clientDir: '/tmp',
      astroEntry: '/tmp',
      newSessionCwd: os.tmpdir(),
      jobLogDir: '/tmp',
      appsRoot,
      trustProxy: 0,
      editorUpstream: null,
      grafanaExploreUrl: null,
    },
    stateDb: db,
    auth: { username: () => USERNAME, configured: () => USERNAME },
    scheduler: {},
    autoUpdater: {},
    objectStore: {},
    killSession: async () => true,
    spawnSession: async name => ({ ok: true, resultType: 'tmux_session', data: { name } }),
    liveSessionNames: async () => new Set(),
    appsServing: serving,
    ...(now === undefined ? {} : { now }),
  });
}

/** reachable host, booted, nothing mounted. */
function hostDown() {
  let calls = 0;
  return {
    calls: () => calls,
    info: async () => {
      calls += 1;
      return {
        reachable: false,
        status: null,
        failureReason: 'app host unreachable (test)',
      };
    },
  };
}

test('appsStatus: rows × mounted × built/stale plus unregistered trees — the AppsStatusData shape', async () => {
  const db = freshDb();
  const appsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-appsroot-'));
  const a = new Apps({ db, username: () => USERNAME, killSession: async () => true });
  // A registered row with no tree (the + app state: buildable, nothing there).
  await a.saveApp('Bare Row');
  // A registered row pointing at a built tree.
  const builtDir = path.join(appsRoot, 'built-app');
  fs.mkdirSync(path.join(builtDir, 'dist', 'server'), { recursive: true });
  fs.writeFileSync(path.join(builtDir, 'app.json'), JSON.stringify({ name: 'Built App' }));
  fs.writeFileSync(path.join(builtDir, 'dist', 'server', 'entry.mjs'), 'export {}');
  fs.writeFileSync(path.join(builtDir, 'dist', 'route-table.json'), '{}');
  await a.saveApp('Built App', builtDir);
  // An unregistered tree: app.json, no row.
  const unDir = path.join(appsRoot, 'unreg-app');
  fs.mkdirSync(unDir, { recursive: true });
  fs.writeFileSync(path.join(unDir, 'app.json'), JSON.stringify({ name: 'Unreg App' }));

  const serving = hostDown();
  const s = services(db, appsRoot, serving);
  const r = await s.appsStatus();
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.resultType, 'apps_status');
  assert.equal(r.data.appsRoot, appsRoot);
  const bySlug = Object.fromEntries(r.data.apps.map(x => [x.slug, x]));
  assert.deepEqual(
    Object.keys(bySlug).sort(),
    ['bare-row', 'built-app', 'unreg-app'],
    JSON.stringify(r.data.apps),
  );
  // The row with no tree: registered, nothing built, the host's reason.
  assert.deepEqual(bySlug['bare-row'], {
    slug: 'bare-row',
    name: 'Bare Row',
    registered: true,
    tree: null,
    hasManifest: false,
    built: false,
    buildStale: null,
    mounted: false,
    servingReason: 'app host unreachable (test)',
  });
  // The built tree: manifest name wins, fresh build, unmounted.
  assert.equal(bySlug['built-app'].name, 'Built App');
  assert.equal(bySlug['built-app'].registered, true);
  assert.equal(bySlug['built-app'].hasManifest, true);
  assert.equal(bySlug['built-app'].built, true);
  assert.equal(bySlug['built-app'].buildStale, false);
  assert.equal(bySlug['built-app'].mounted, false);
  // The scaffolded-but-unregistered tree.
  assert.equal(bySlug['unreg-app'].registered, false);
  assert.equal(bySlug['unreg-app'].tree, unDir);
  assert.deepEqual(r.data.unregisteredTrees, ['unreg-app']);
});

test('appsStatus: ~10 s TTL — the poll cannot storm the fs; expiry and invalidate rejoin', async () => {
  const db = freshDb();
  const appsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-appsroot-'));
  const serving = hostDown();
  let t = 1_000_000;
  const s = services(db, appsRoot, serving, () => t);
  const first = await s.appsStatus();
  assert.equal(first.ok, true, first.errorMessage);
  assert.equal(first.data.apps.length, 0);
  assert.equal(serving.calls(), 1);

  // A tree appears (the fs walk's observable), but the cache hides it.
  fs.mkdirSync(path.join(appsRoot, 'late-app'), { recursive: true });
  fs.writeFileSync(
    path.join(appsRoot, 'late-app', 'app.json'),
    JSON.stringify({ name: 'Late App' }),
  );
  t += 9_999; // inside the window
  const cached = await s.appsStatus();
  assert.equal(cached.data.apps.length, 0, 'the TTL window serves the cached join');
  assert.equal(serving.calls(), 1, 'no host ping either');

  // One ms past the window: the join re-runs and sees the tree.
  t += 1;
  const fresh = await s.appsStatus();
  assert.deepEqual(fresh.data.unregisteredTrees, ['late-app'], 'an expired cache rejoins the fs');
  assert.equal(serving.calls(), 2);

  // The user's own create/delete must never wait out the TTL.
  t += 1; // still inside the new window
  s.invalidateAppsStatus();
  const afterInvalidate = await s.appsStatus();
  assert.equal(afterInvalidate.data.apps.length, 1);
  assert.equal(serving.calls(), 3);

  // database_error is the only failure: a broken db read fails closed.
  const broken = services(
    {
      all: () => {
        throw new Error('unreadable');
      },
    },
    appsRoot,
    serving,
    () => t,
  );
  const failed = await broken.appsStatus();
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'database_error');
});
