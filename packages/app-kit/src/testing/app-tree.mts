// The ESM twin of ../app-data.ts's tree walk. This whole subtree runs only
// inside ESM contexts (the Playwright runner loads these sources directly),
// and cannot import the CJS-dialect kit root across that wall — Playwright's
// transform compiles each file per its nearest package.json, so a named
// import from the CJS half breaks at runtime. tests/unit/
// app-kit-testing.test.mjs pins this copy's env name to the root copy's,
// and the notes app's e2e asserts the built app's data lands in the harness
// dir, not the tree's data/.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DATA_DIR_ENV = 'CYBERMOLE_APP_DATA_DIR';

function toPath(from: URL | string): string {
  if (from instanceof URL) return fileURLToPath(from);
  return from.startsWith('file:') ? fileURLToPath(from) : path.resolve(from);
}

/** The app tree's root: the nearest ancestor holding app.json. `from` is
 *  any file inside the tree (import.meta.url) or a directory in it. */
export function appRootFrom(from: URL | string): string {
  const start = toPath(from);
  let dir = path.dirname(start);
  try {
    if (fs.statSync(start).isDirectory()) dir = start;
  } catch {
    /* not on disk: still names a place in the tree */
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, 'app.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(`no app.json above ${dir} — not running inside an app tree`);
    dir = parent;
  }
}
