// The app-tree conventions: where an app finds its own root and its data
// dir. `data/` (the starter's gitignored dir) is found by walking up to
// app.json — works from src/ and from the built dist/server chunks alike,
// since both live inside the tree. CYBERMOLE_APP_DATA_DIR overrides the
// data location wholesale: the kit's e2e harness (./testing) points a
// built app at a per-run temp dir, so a test run never touches the tree's
// real data.
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

/** The app's data dir (its sqlite lives there). CYBERMOLE_APP_DATA_DIR, when
 *  set to a non-empty value, wins absolutely. */
export function appDataDir(from: URL | string): string {
  const raw = process.env[APP_DATA_DIR_ENV];
  if (raw !== undefined && raw.trim() !== '') return path.resolve(raw);
  return path.join(appRootFrom(from), 'data');
}
