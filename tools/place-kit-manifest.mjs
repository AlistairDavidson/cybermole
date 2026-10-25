// The kit is TS source with no build of its own; tsc compiles it into
// dist-server/packages/app-kit/src. This places a package manifest in
// dist-server/node_modules pointing at those files, so the compiled
// require('@cybermole/app-kit') resolves without the source symlink (and
// without type stripping, which node 22 lacks). Only the root specifier is
// mapped: server code never imports subpaths.
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const dir = path.resolve('dist-server/node_modules/@cybermole/app-kit');
mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(dir, 'package.json'),
  `${JSON.stringify({ name: '@cybermole/app-kit', type: 'commonjs', main: '../../../packages/app-kit/src/index.js' }, null, 2)}\n`,
);
