import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import lit from '@awesome.me/astro-lit';
// The CYBERMOLE_* env contract, shared with src/lib/platform/env.ts.
import { envSchema } from './src/lib/platform/env-schema';
import { UPLOAD_MAX_BODY_BYTES } from './src/schemas/uploads';

// Astro renders pages and the JSON API in middleware mode; the compiled Node
// server gates every request before calling in and owns login/logout and the
// terminal WS. CYBERMOLE_BASE is baked in at build time, so set it for both
// the build and the server.
const base = process.env.CYBERMOLE_BASE ?? '/';

// `astro dev` only: the API, partials, editor and WS need the services in
// `npm run dev:server` (:3001), so Vite proxies there. GET/HEAD /login and
// /logout stay local (they're real pages). Inert outside `astro dev`.
const devApiTarget = process.env.CYBERMOLE_DEV_API ?? 'http://127.0.0.1:3001';
const pageMethodsOnly = req =>
  req.method === 'GET' || req.method === 'HEAD' ? req.url : undefined;
const devProxy = {
  [`${base}api`]: { target: devApiTarget },
  [`${base}partials`]: { target: devApiTarget },
  [`${base}editor`]: { target: devApiTarget, ws: true },
  [`${base}ws`]: { target: devApiTarget, ws: true },
  [`${base}login`]: { target: devApiTarget, bypass: pageMethodsOnly },
  [`${base}logout`]: { target: devApiTarget, bypass: pageMethodsOnly },
};

export default defineConfig({
  output: 'server',
  // Global, so sized for the largest body (an upload); main.ts caps every
  // other route at 10 KiB before Astro reads a byte.
  adapter: node({ mode: 'middleware', bodySizeLimit: UPLOAD_MAX_BODY_BYTES }),
  // Off: main.ts already rejects cross-origin non-GETs, proxy-aware. Astro's
  // check sees http:// behind a TLS proxy and would 403 same-origin posts.
  security: { checkOrigin: false },
  integrations: [lit()], // Web Awesome SSR (declarative shadow DOM)
  base,
  srcDir: './src',
  outDir: './dist', // dist/client (assets) + dist/server/entry.mjs (SSR handler)
  env: {
    // Server-context secrets, read from process.env at runtime.
    schema: envSchema,
  },
  // The kit ships TS source; bundle it rather than externalize it, so the
  // entry never resolves .ts through the symlink at runtime.
  vite: {
    ssr: { noExternal: ['@cybermole/app-kit'] },
    server: { proxy: devProxy },
  },
});
