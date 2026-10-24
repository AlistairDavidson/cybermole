// fixture app, built by its own toolchain — resolves its core stack from
// the repo's node_modules (per-package symlinks; setup-node-modules.mjs),
// so the versions are exactly the image's.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import lit from '@awesome.me/astro-lit';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
// the app's own per-package links (the image's core stack) — every alias
// below resolves THROUGH them, never around them, so the recipe works
// identically in the repo and in the image.
const link = (...rest) => path.join(fixtureRoot, 'node_modules', ...rest);

// base: '/apps/<slug>' is BAKED at build (apps-plan §2: slugs are stable
// once created, so the baked base never goes stale; the host forwards
// paths verbatim — no prefix rewriting anywhere).
const base = '/apps/app-fixture';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  integrations: [lit()],
  base,
  srcDir: './src',
  outDir: './dist',
  security: { checkOrigin: false }, // the host socket is not a browser origin; gated upstream
  vite: {
    resolve: {
      alias: [
        // The astro-lit renderer entrypoint is force-EXTERNALIZED by the
        // integration's own vite config (and readFileSync()s its own
        // package.json, so it cannot be bundled as shipped). Alias it to
        // our vendored, bundle-friendly copy (src/vendor/) and the whole
        // renderer inlines into the build.
        {
          find: '@awesome.me/astro-lit/server.js',
          replacement: path.join(fixtureRoot, 'src', 'vendor', 'astro-lit-server.mjs'),
        },
        // The renderer's own imports are on that same external list
        // ('lit-element', 'lit/decorators.js', '@lit-labs/ssr'). Aliasing
        // each to a real path through the app's links defeats the
        // specifier match and lets noExternal inline them. Directory
        // targets also cover deep imports (lit-element/private-ssr-support.js).
        { find: 'lit-element', replacement: link('lit-element') },
        { find: 'lit/decorators.js', replacement: link('lit', 'decorators.js') },
        {
          find: '@lit-labs/ssr',
          replacement: link('@awesome.me', 'astro-lit', 'node_modules', '@lit-labs', 'ssr'),
        },
      ],
    },
    ssr: {
      // THE load-bearing build property (apps-plan §5, settled on THIS
      // fixture by branch 1): the built dist/server graph must be
      // self-contained apart from node: builtins — serve-time must never
      // resolve through a node_modules symlink an app's extra install
      // could disturb. noExternal: true inlines every non-builtin import
      // into dist/server (node: stays external); verified by
      // tools/check-app-selfcontained.mjs.
      noExternal: true,
      rollupOptions: {
        output: {
          // hashed chunk names: a REBUILD changes a chunk's content hash,
          // so the (stable-named) entry references a NEW path and the
          // host's cache-busted re-import picks the new build up whole —
          // a same-named changed chunk would stay stale in the ESM cache.
          chunkFileNames: 'chunks/[name]-[hash].mjs',
        },
      },
    },
  },
});
