import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import lit from '@awesome.me/astro-lit';
// Typed env-var contract for every CYBERMOLE_* variable the server reads —
// the single source of truth, shared with src/lib/env.ts (the compiled
// server's typed reads; see that file for why the server cannot import
// 'astro:env/server' directly). Plain data in envField() output shape.
import { envSchema } from './src/lib/env-schema';
import { UPLOAD_MAX_BODY_BYTES } from './src/schemas/uploads';

// SSR build: Astro renders pages AND the JSON API (src/pages/api) on
// demand (middleware-mode handler); the compiled Node server (dist-server/)
// gates every request (origin, session) before calling into it, and keeps
// login/logout and the WS→node-pty bridge itself. One process.
//
// CYBERMOLE_BASE is baked into the pages at build time — for subpath deploys
// (e.g. /console on a dedicated vhost; the app wants its own hostname,
// see README "Security model") set it before `npm run build`
// AND at server runtime; the pages and the server must agree.
const base = process.env.CYBERMOLE_BASE ?? '/';

// Dev (`astro dev`) only: the JSON API needs the services server/main.ts
// builds (src/middleware.ts answers 503 without them), and the terminal WS
// and login/logout live in the Node server itself — so `npm run dev:server`
// runs that half on :3001 (builds, boots, then rebuilds and restarts itself
// on source change — tools/dev-server-watch.mjs) and Vite forwards to it. GET/HEAD /login and /logout stay on the dev server (they are the
// real Astro pages) — `bypass` returning the URL hands those back to the
// dev server instead of proxying (vite: string → serve locally).
// NOTE: `server.proxy` is inert outside `astro dev` (build never runs a
// dev server; prod is dist-server/server/main.js), and Astro has no
// command-conditional config form — so it is simply always declared.
const devApiTarget = process.env.CYBERMOLE_DEV_API ?? 'http://127.0.0.1:3001';
const pageMethodsOnly = req =>
  req.method === 'GET' || req.method === 'HEAD' ? req.url : undefined;
const devProxy = {
  [`${base}api`]: { target: devApiTarget },
  // server-rendered fragments (src/pages/partials) need the services too
  [`${base}partials`]: { target: devApiTarget },
  // task/ws-editor: the same-origin editor proxy lives in main.ts with the
  // services — and its WebSockets dial `<base>/editor/…`, so ws:true
  [`${base}editor`]: { target: devApiTarget, ws: true },
  [`${base}ws`]: { target: devApiTarget, ws: true },
  [`${base}login`]: { target: devApiTarget, bypass: pageMethodsOnly },
  [`${base}logout`]: { target: devApiTarget, bypass: pageMethodsOnly },
};

export default defineConfig({
  output: 'server',
  // bodySizeLimit: the adapter's default is 1 GiB. The limit is global, so
  // it is the largest body any route takes — an upload to POST /api/files
  // (file + multipart envelope, src/schemas/uploads.ts). Every other route
  // keeps the JSON API's 10 KiB: server/main.ts answers 413 (or 411 for a
  // body with no Content-Length) before Astro reads a byte. Past this, a
  // body aborts mid-stream and fails to parse — a 400.
  adapter: node({ mode: 'middleware', bodySizeLimit: UPLOAD_MAX_BODY_BYTES }),
  // Astro's own origin check is OFF on purpose: server/main.ts already
  // rejects every cross-origin non-GET before a request reaches Astro
  // (originOk(), CYBERMOLE_TRUST_PROXY-aware). Astro's check derives the
  // expected origin from the request URL, which behind a TLS-terminating
  // proxy is http:// — it would 403 same-origin form posts and every
  // bodyless POST/DELETE (run job, delete job). One authoritative check;
  // tests/e2e.spec.ts covers it. (docs/CODE_STYLE.md §6)
  security: { checkOrigin: false },
  integrations: [lit()], // Web Awesome SSR (declarative shadow DOM)
  base,
  srcDir: './src',
  outDir: './dist', // dist/client (assets) + dist/server/entry.mjs (SSR handler)
  env: {
    // All server-context secrets: Astro reads these from process.env at
    // runtime. (public would inline build-time values into the SSR bundle —
    // wrong for vars the operator sets when starting the built server.)
    schema: envSchema,
  },
  // trailingSlash 'ignore' — the Node server decides what / and /login map to.
  // The kit (@cybermole/app-kit, an npm workspace) ships TS source; Vite
  // would externalize it like any node_modules dep (serve-time would then
  // resolve the source symlink's .ts exports — no such thing at runtime).
  // noExternal bundles it into dist/server/entry.mjs instead, compiled from
  // source — the same self-contained-entry property apps' builds get
  // (docs/apps-plan.md §5).
  vite: {
    ssr: { noExternal: ['@cybermole/app-kit'] },
    server: { proxy: devProxy },
  },
});
