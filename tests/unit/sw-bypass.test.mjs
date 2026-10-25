// sw.js must bypass editor/ like api/ and partials/: unhashed editor assets
// would mix versions after an upgrade, and authed content would outlive
// logout. Loads the real file in a vm and drives its fetch listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SW_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
  'sw.js',
);

function loadServiceWorker(scopeUrl) {
  const listeners = {};
  const cache = { put: async () => {} };
  const caches = {
    open: async () => cache,
    keys: async () => [],
    match: async () => undefined,
    delete: async () => true,
  };
  const self = {
    registration: { scope: scopeUrl },
    location: { origin: new URL(scopeUrl).origin },
    addEventListener: (name, fn) => {
      (listeners[name] ??= []).push(fn);
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  const context = vm.createContext({
    self,
    caches,
    URL,
    Response,
    location: self.location,
    fetch: async () => new Response('', { status: 504, statusText: 'offline' }),
  });
  vm.runInContext(readFileSync(SW_PATH, 'utf8'), context, { filename: 'sw.js' });
  return listeners;
}

/** true if a listener called respondWith; false means bypassed. */
async function swHandles(listeners, url, method = 'GET') {
  const claims = [];
  const event = {
    request: { method, url, mode: 'same-origin' },
    respondWith: p => {
      claims.push(p);
    },
    waitUntil: () => {},
  };
  for (const fn of listeners.fetch ?? []) fn(event);
  await Promise.allSettled(claims);
  return claims.length > 0;
}

test('sw.js: editor/ is never served from the cache (mixed-version assets, authed content, offline shell)', async () => {
  const sw = loadServiceWorker('http://127.0.0.1:4000/');
  // the workbench HTML and its assets, under the base
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/editor/'), false, 'workbench HTML');
  assert.equal(
    await swHandles(sw, 'http://127.0.0.1:4000/editor/?folder=%2Fworkspace'),
    false,
    'folder URL',
  );
  assert.equal(
    await swHandles(
      sw,
      'http://127.0.0.1:4000/editor/stable-8072/out/vs/code/browser/workbench/workbench.js',
    ),
    false,
    'workbench bundle',
  );
  assert.equal(
    await swHandles(
      sw,
      'http://127.0.0.1:4000/editor/stable-8072/out/vs/workbench/api/nodeProxy.js',
    ),
    false,
  );
  // under a CYBERMOLE_BASE mount too
  const swBase = loadServiceWorker('http://127.0.0.1:4000/foo/');
  assert.equal(
    await swHandles(
      swBase,
      'http://127.0.0.1:4000/foo/editor/stable-8072/out/vs/base/worker/workerMain.js',
    ),
    false,
  );
});

test('sw.js: the other paths keep their established behavior', async () => {
  const sw = loadServiceWorker('http://127.0.0.1:4000/');
  // live data routes are bypassed
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/api/state'), false);
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/partials/jobs-list'), false);
  assert.equal(
    await swHandles(sw, 'http://127.0.0.1:4000/api/anything'),
    false,
    'path outside bypass shape but api/',
  );
  // hashed assets (cache-first) and navigations (network-first) are handled
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/_astro/chunk-abc123.js'), true);
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/jobs', 'GET'), true, 'navigate');
  // non-GET never reaches the cache paths
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/editor/stable-8072/x', 'POST'), false);
  // cross-origin isn't ours
  assert.equal(await swHandles(sw, 'https://open-vsx.org/vscode/gallery'), false);
});
