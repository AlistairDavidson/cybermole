// apps-gate.ts: the lint:arch fallback — a tree with a component layer
// (src/components or src/store) that deleted its lint:arch script still gets
// the architecture lint, run host-side by the gate. Deletion of a script
// line must not silence the standard; pre-standard trees (no component
// layer at all) keep passing with the skip note.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const { checkApp, normalizeAppBase } = await import('../../dist-server/src/lib/apps/apps-gate.js');
const { runChild } = await import('../../dist-server/src/lib/apps/apps-child.js');

/** A stub tree: every stage script is a no-op, so only the lint decides. */
function stubTree(root, label, withComponentLayer, violating) {
  const tree = path.join(root, `${label}-tree`);
  fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'node_modules', '.bin'), { recursive: true });
  for (const bin of ['astro', 'tsc'])
    fs.closeSync(fs.openSync(path.join(tree, 'node_modules', '.bin', bin), 'w'));
  if (withComponentLayer) fs.mkdirSync(path.join(tree, 'src', 'components'), { recursive: true });
  fs.writeFileSync(
    path.join(tree, 'src', 'index.ts'),
    violating
      ? "export const x = (el) => { el.innerHTML = '<p>no</p>'; };\n"
      : 'export const x = 1;\n',
  );
  fs.writeFileSync(
    path.join(tree, 'package.json'),
    JSON.stringify(
      {
        name: label,
        private: true,
        scripts: { typecheck: 'node -e 0', test: 'node -e 0', build: 'node -e 0' },
      },
      null,
      2,
    ),
  );
  return tree;
}

test('lint:arch: deleting the script cannot silence the gate under a component layer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-apps-gate-'));
  const deps = { appsRoot: root, installRoot: REPO, run: runChild };

  // No lint:arch script, HAS a component layer, src violates → gate fails.
  fs.mkdirSync(root, { recursive: true });
  const bad = stubTree(root, 'bad', true, true);
  const badResult = await checkApp(deps, path.basename(bad));
  assert.equal(badResult.ok, true);
  assert.equal(badResult.data.envelope.passed, false);
  assert.ok(
    badResult.data.envelope.failures?.some(f => f.stage.includes('architecture lint')),
    JSON.stringify(badResult.data.envelope),
  );

  // Same tree shape, clean src → passes, with the host-run stage in the line.
  const good = stubTree(root, 'good', true, false);
  const goodResult = await checkApp(deps, path.basename(good));
  assert.equal(goodResult.ok, true);
  assert.equal(goodResult.data.envelope.passed, true, goodResult.data.envelope.output);
  assert.match(goodResult.data.envelope.output, /architecture lint \(host-run\)/);

  // No component layer at all (a pre-standard tree) → lint skipped, named.
  const legacy = stubTree(root, 'legacy', false, true);
  const legacyResult = await checkApp(deps, path.basename(legacy));
  assert.equal(legacyResult.ok, true);
  assert.equal(legacyResult.data.envelope.passed, true);
  assert.match(legacyResult.data.envelope.output, /lint:arch not in tree/);
});

// ---------- normalizeAppBase ----------

test('normalizeAppBase: re-bakes the astro base line, idempotently; a config without the line is untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-gate-base-'));
  const tree = path.join(root, 'notes');
  fs.mkdirSync(tree);
  const config = path.join(tree, 'astro.config.mjs');
  const write = text => fs.writeFileSync(config, text);
  const read = () => fs.readFileSync(config, 'utf8');

  // stale root base under a subpath console
  write("// a config\nconst base = '/apps/notes';\nexport default { base };\n");
  let r = normalizeAppBase(tree, 'notes', '/console');
  assert.deepEqual(r, { changed: true, from: '/apps/notes', to: '/console/apps/notes' });
  assert.ok(read().includes("const base = '/console/apps/notes';"), 'line re-baked');
  // idempotent
  r = normalizeAppBase(tree, 'notes', '/console');
  assert.deepEqual(r, { changed: false, from: '/console/apps/notes', to: '/console/apps/notes' });

  // the site root is the '' prefix
  r = normalizeAppBase(tree, 'notes', '/');
  assert.deepEqual(r, { changed: true, from: '/console/apps/notes', to: '/apps/notes' });

  // a heavily customized config without the scaffolded line: never guessed at
  write('export default { base: process.env.APP_BASE };\n');
  r = normalizeAppBase(tree, 'notes', '/console');
  assert.deepEqual(r, { changed: false, from: null, to: '/console/apps/notes' });
  assert.equal(read(), 'export default { base: process.env.APP_BASE };\n');

  // a missing file is the same non-answer
  fs.rmSync(config);
  r = normalizeAppBase(tree, 'notes', '/console');
  assert.deepEqual(r, { changed: false, from: null, to: '/console/apps/notes' });
});
