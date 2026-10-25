// The fixture app's build. Its core stack resolves through per-package
// symlinks into the repo's node_modules (setup-node-modules.mjs).
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import lit from '@awesome.me/astro-lit';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
// Every alias below resolves through the app's own links.
const link = (...rest) => path.join(fixtureRoot, 'node_modules', ...rest);

// The base is baked at build; the host forwards paths verbatim.
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
        // astro-lit forces its renderer external (and it reads its own
        // package.json), so alias it to the bundleable vendored copy.
        {
          find: '@awesome.me/astro-lit/server.js',
          replacement: path.join(fixtureRoot, 'src', 'vendor', 'astro-lit-server.mjs'),
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
      // symlinks (tools/check-app-selfcontained.mjs checks it).
      noExternal: true,
      rollupOptions: {
        output: {
          // A rebuild changes chunk hashes, so the stable-named entry points
          // at new paths; a same-named changed chunk would stay stale in the
          // ESM cache.
          chunkFileNames: 'chunks/[name]-[hash].mjs',
        },
      },
    },
  },
});
