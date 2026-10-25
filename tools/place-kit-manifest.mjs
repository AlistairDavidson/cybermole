// place-kit-manifest.mjs — the runtime half of shipping the kit as source.
//
// The kit (@cybermole/app-kit, packages/app-kit) is TS source with no build
// of its own: astro/vite compiles it through the workspace symlink when an
// app (or the console's Astro half) bundles, and the console's server build
// (tsc -p tsconfig.server.json) compiles it in place — the program pulls it
// through node_modules/@cybermole/app-kit, the emitted files land at
// dist-server/packages/app-kit/src/*.js next to dist-server/src and
// dist-server/server.
//
// What that compiled tree then needs is a resolvable package: the emitted
// require('@cybermole/app-kit') from dist-server/src/**.js walks up into
// dist-server/node_modules, where this script places a manifest whose main
// points back at the compiled files. Serve-time never resolves through the
// source symlink (docs/plans/apps-plan.md §5: the build bundles it; serve-time
// only ever imports dist/) — this keeps dist-server self-contained, so a
// Node without type stripping (the image ships node 22) runs it unchanged.
//
// Subpaths are deliberately absent: server-compiled code imports only the
// root specifier (see packages/app-kit/src/index.ts); the subpath exports
// are for vite-compiled code, which never runs through this manifest.
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const dir = path.resolve('dist-server/node_modules/@cybermole/app-kit');
mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(dir, 'package.json'),
  `${JSON.stringify({ name: '@cybermole/app-kit', type: 'commonjs', main: '../../../packages/app-kit/src/index.js' }, null, 2)}\n`,
);
