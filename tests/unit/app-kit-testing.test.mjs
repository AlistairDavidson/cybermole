// The kit's app-tree data-dir conventions (the root app-data.ts — the face
// apps' server code imports), plus a drift guard on the testing subtree's
// ESM twin (src/testing/app-tree.mts — same walk, same env; the harness
// boots only in ESM contexts, so its twin can't be imported here). The
// harness itself is exercised end to end by the app trees' own e2e
// (runtime/reference-apps/notes and every scaffolded starter sample).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  APP_DATA_DIR_ENV,
  appDataDir,
  appRootFrom,
} from '../../dist-server/packages/app-kit/src/app-data.js';

// A minimal app tree: just the manifest the walk-up looks for.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-harness-'));
fs.writeFileSync(
  path.join(tmp, 'app.json'),
  `${JSON.stringify({ name: 'Fixture', slug: 'fixture' })}\n`,
);

test('appRootFrom: walks up to app.json from a file, a dir and a file: URL', () => {
  assert.equal(appRootFrom(path.join(tmp, 'dist', 'server', 'entry.mjs')), tmp);
  assert.equal(appRootFrom(tmp), tmp);
  assert.equal(appRootFrom(pathToFileURL(path.join(tmp, 'src', 'lib', 'x.ts')).href), tmp);
});

test('appDataDir: the tree data/ by default, the env override absolute when set', () => {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the env slot is the fixture under test
  delete process.env[APP_DATA_DIR_ENV];
  assert.equal(appDataDir(path.join(tmp, 'dist', 'server', 'entry.mjs')), path.join(tmp, 'data'));
  process.env[APP_DATA_DIR_ENV] = 'rel/data';
  try {
    assert.equal(
      appDataDir(path.join(tmp, 'dist', 'server', 'entry.mjs')),
      path.resolve('rel/data'),
    );
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the env slot is the fixture under test
    delete process.env[APP_DATA_DIR_ENV];
  }
});

test('appDataDir: no app.json above is a loud error, not a guess', () => {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the env slot is the fixture under test
  delete process.env[APP_DATA_DIR_ENV];
  assert.throws(() => appDataDir(import.meta.url), /no app\.json above/);
});

test("the testing subtree's ESM twin agrees with the root copy (drift guard)", () => {
  const twin = fileURLToPath(
    new URL('../../packages/app-kit/src/testing/app-tree.mts', import.meta.url),
  );
  const source = fs.readFileSync(twin, 'utf8');
  // The env the harness sets is the env the built app's appDataDir() reads.
  assert.match(source, new RegExp(`['"]${APP_DATA_DIR_ENV}['"]`));
  assert.match(source, /appRootFrom/);
});
