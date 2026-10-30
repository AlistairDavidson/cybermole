// A cybermole app's build config. The base '__APP_BASE__/apps/__APP_SLUG__'
// is baked in at scaffold time (slugs never change; the console's URL base
// rides every request the proxy forwards, so the app bakes it too — the
// build verb re-normalizes this line whenever the console base changes).
// The node adapter runs in middleware mode for the app host, and the build
// emits dist/route-table.json. Core dependencies resolve through per-package
// node_modules symlinks into the cybermole install.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import lit from '@awesome.me/astro-lit';
import { writeRouteTable } from '@cybermole/app-kit/route-table-emit';
import { routes } from './src/routes';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
// Every alias below resolves through the app's own links.
const link = (...rest) => path.join(appRoot, 'node_modules', ...rest);

const base = '__APP_BASE__/apps/__APP_SLUG__';

// Emitted from here because astro's config loader compiles TS: a plain-node
// post-build script couldn't import the kit's TS sources from node_modules.
const emitRouteTable = () => ({
  name: 'emit-route-table',
  hooks: {
    'astro:build:done': () => {
      writeRouteTable(routes, path.join(appRoot, 'dist', 'route-table.json'), base);
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
        // astro-lit forces its renderer external (and it reads its own
        // package.json), so alias it to the bundleable vendored copy.
        {
          find: '@awesome.me/astro-lit/server.js',
          replacement: path.join(appRoot, 'src', 'vendor', 'astro-lit-server.mjs'),
        },
        // The renderer's imports are on the same external list; aliasing
        // them to real paths lets noExternal inline them. Directory targets
        // also cover deep imports.
        { find: 'lit-element', replacement: link('lit-element') },
        { find: 'lit/decorators.js', replacement: link('lit', 'decorators.js') },
        {
          find: '@lit-labs/ssr',
          replacement: link('@awesome.me', 'astro-lit', 'node_modules', '@lit-labs', 'ssr'),
        },
      ],
    },
    ssr: {
      // The built dist/server graph must be self-contained apart from
      // node: builtins, so serving never resolves through node_modules
      // symlinks. scripts/check-selfcontained.mjs gates every build.
      noExternal: true,
      rollupOptions: {
        output: {
          // A rebuild changes chunk hashes, so the stable-named entry points
          // at new paths and the host's re-import picks up the whole build.
          chunkFileNames: 'chunks/[name]-[hash].mjs',
        },
      },
    },
  },
});
