// sw-bypass.test.mjs — public/sw.js's fetch handler must SKIP editor/
// exactly like api/ and partials/ (plan §8): the editor's asset paths are
// unhashed, so stale-while-revalidate would serve MIXED-VERSION workbench
// assets after an editor upgrade, authed editor content would stay cached
// beyond logout, and the offline shell would render inside the iframe.
// Loads the real service worker file in a vm with stubbed self/caches and
// drives its registered fetch listener directly.
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

/** The registered listeners of sw.js run in a sandboxed realm. */
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

/** Fire the fetch event for a request; true iff any listener claimed it
 *  with respondWith (false = bypassed: straight to the network). */
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
  // the workbench HTML and its unhashed assets, under the app's base
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
  // the bypass holds under a WEB_PI_BASE mount too
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
  // still bypassed: live data routes
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/api/state'), false);
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/partials/jobs-list'), false);
  assert.equal(
    await swHandles(sw, 'http://127.0.0.1:4000/api/anything'),
    false,
    'path outside bypass shape but api/',
  );
  // still handled: hashed assets (cache-first) and navigations (network-first)
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/_astro/chunk-abc123.js'), true);
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/jobs', 'GET'), true, 'navigate');
  // non-GET never touches the handler's cache paths
  assert.equal(await swHandles(sw, 'http://127.0.0.1:4000/editor/stable-8072/x', 'POST'), false);
  // a cross-origin request is not ours to handle
  assert.equal(await swHandles(sw, 'https://open-vsx.org/vscode/gallery'), false);
});
