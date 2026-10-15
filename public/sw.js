const VERSION = 'web-pi-v3'; // v3: /editor/* bypass the cache (old caches are dropped on activate)
const SCOPE = new URL(self.registration.scope); // <origin><base>/
const at = p => new URL(p, SCOPE).href;
const PRECACHE = [
  'offline',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  // Vendored Web Awesome glyphs (public/icons/wa/solid) — the offline
  // shell and its toast icon render with no network at all.
  'icons/wa/solid/arrows-rotate.svg',
  'icons/wa/solid/arrow-left.svg',
  'icons/wa/solid/circle-check.svg',
  'icons/wa/solid/circle-info.svg',
  'icons/wa/solid/clock.svg',
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
  '<!doctype html><meta charset="utf-8"><title>web-pi — offline</title>' +
  '<body style="font:15px/1.5 system-ui;padding:2rem">' +
  'web-pi is offline — reconnect to continue.</body>';

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
  // Live per-user data is never served from cache: the JSON API, the
  // server-rendered partials (fragments the pages swap in as refreshes —
  // a stale one would undo a delete on screen), and the proxied editor
  // (task/ws-editor): VS Code's asset paths are unhashed, so a cached copy
  // would serve MIXED-VERSION workbench assets after an editor upgrade
  // (the classic blank-editor failure), authed editor content would outlive
  // its logout, and the offline shell would render inside the iframe.
  if (
    rel.startsWith('api/') ||
    rel.startsWith('partials/') ||
    rel.startsWith('editor/') ||
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
