const VERSION = 'cybermole-v7'; // bump to drop old caches on activate
const SCOPE = new URL(self.registration.scope); // <origin><base>/
const at = p => new URL(p, SCOPE).href;
const PRECACHE = [
  'offline',
  'manifest.webmanifest',
  'cybermole.svg',
  'icons/icon-dark.svg',
  // The offline shell must render in the browser's mode with no network.
  'theme-boot.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/wa/solid/arrows-rotate.svg',
  'icons/wa/solid/arrow-left.svg',
  'icons/wa/solid/circle-check.svg',
  'icons/wa/solid/circle-info.svg',
  'icons/brand/mole.svg',
  'icons/wa/solid/clock.svg',
  'icons/wa/solid/cubes.svg',
  'icons/wa/solid/eye.svg',
  'icons/wa/solid/eye-slash.svg',
  'icons/wa/solid/folder.svg',
  'icons/wa/solid/gear.svg',
  'icons/wa/solid/magnifying-glass.svg',
  'icons/wa/solid/pencil.svg',
  'icons/wa/solid/play.svg',
  'icons/wa/solid/plus.svg',
  'icons/wa/solid/right-from-bracket.svg',
  'icons/wa/solid/rotate-right.svg',
  'icons/wa/solid/terminal.svg',
  'icons/wa/solid/trash-can.svg',
  'icons/wa/solid/triangle-exclamation.svg',
].map(at);

const FALLBACK_HTML =
  '<!doctype html><meta charset="utf-8"><title>cybermole — offline</title>' +
  '<body style="font:15px/1.5 system-ui;padding:2rem">' +
  'cybermole is offline — reconnect to continue.</body>';

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await Promise.all(
        PRECACHE.map(async url => {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* already offline: install with what we have */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n !== VERSION).map(n => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return; // login/logout POSTs: always network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const dir = SCOPE.pathname; // '<base>/'
  const rel = url.pathname.startsWith(dir) ? url.pathname.slice(dir.length) : null;
  if (rel === null) return; // outside the app's base
  // Never cached: the API, partials (a stale one would undo a delete on
  // screen) and the editor, whose unhashed asset paths would mix versions
  // after an upgrade and whose authed content would outlive logout. Apps
  // too, whole: their pages are authed and live (an app's own fetches —
  // its API actions, its live-refresh re-fetches — must never answer from
  // a stale-while-revalidate copy), and their unhashed assets would mix
  // versions across app rebuilds. The app host owns its freshness.
  if (
    rel.startsWith('api/') ||
    rel.startsWith('partials/') ||
    rel.startsWith('editor/') ||
    rel.startsWith('apps/') ||
    rel === 'ws' ||
    rel === 'sw.js'
  )
    return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
  } else if (rel.startsWith('_astro/')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirstNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    const shell = await caches.match(at('offline'));
    return (
      shell ||
      new Response(FALLBACK_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(VERSION);
      await cache.put(request, res.clone());
    }
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async res => {
      if (res.ok) {
        const cache = await caches.open(VERSION);
        await cache.put(request, res.clone());
      }
      return res;
    })
    .catch(() => undefined);
  return cached || (await refresh) || new Response('', { status: 504, statusText: 'offline' });
}
