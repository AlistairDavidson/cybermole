// A cybermole app's build config, baked from the image's app-starter
// template by the cybermole-apps scaffold: base '/apps/<slug>' BAKED at
// scaffold time (slugs are stable once created, so the baked base never
// goes stale; the host forwards paths verbatim — no prefix rewriting,
// apps-plan §2), the node adapter in middleware mode (the app host mounts
// dist/server/entry.mjs), astro-lit for Web Awesome SSR, and the kit's
// route-table emission riding the build itself (dist/route-table.json —
// what describe/call and the app's MCP shim read).
//
// Core dependencies resolve through this tree's PER-PACKAGE node_modules
// symlinks into the cybermole install's node_modules
// (scripts/setup-node-modules.mjs — apps-plan §5): the image's versions,
// zero registry.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import lit from '@awesome.me/astro-lit';
import { writeRouteTable } from '@cybermole/app-kit/route-table-emit';
import { routes } from './src/routes';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
// The app's own per-package links (the install's core stack) — every
// alias below resolves THROUGH them, never around them.
const link = (...rest) => path.join(appRoot, 'node_modules', ...rest);

const base = '/apps/notes';

// dist/route-table.json, emitted when the build completes. The emission
// lives HERE (astro's config loader esbuild-bundles this file, so the
// kit's TS sources and this tree's TS table both compile) because a
// plain-node post-build script could import neither: the kit ships TS
// sources, and node refuses to type-strip anything under node_modules.
const emitRouteTable = () => ({
  name: 'emit-route-table',
  hooks: {
    'astro:build:done': () => {
      writeRouteTable(routes, path.join(appRoot, 'dist', 'route-table.json'));
    },
  },
});

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  integrations: [lit(), emitRouteTable()],
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
        // the vendored, bundle-friendly copy (src/vendor/) and the whole
        // renderer inlines into the build.
        {
          find: '@awesome.me/astro-lit/server.js',
          replacement: path.join(appRoot, 'src', 'vendor', 'astro-lit-server.mjs'),
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
      // THE load-bearing build property (apps-plan §5): the built
      // dist/server graph must be self-contained apart from node: builtins
      // — serve-time (the app host importing the entry) must never resolve
      // through a node_modules symlink an app's extra install could
      // disturb. noExternal: true inlines every non-builtin import into
      // dist/server (node: stays external); scripts/check-selfcontained.mjs
      // gates every build on it (part of `npm run build`).
      noExternal: true,
      rollupOptions: {
        output: {
          // hashed chunk names: a REBUILD changes a chunk's content hash,
          // so the (stable-named) entry references a NEW path and the
          // host's cache-busted re-import picks the new build up whole.
          chunkFileNames: 'chunks/[name]-[hash].mjs',
        },
      },
    },
  },
});
