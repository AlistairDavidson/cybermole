#!/usr/bin/env node
// setup-node-modules.mjs — create the fixture's node_modules as
// PER-PACKAGE SYMLINKS into the repo's node_modules (apps-plan §5's
// resolution shape): the core stack resolves from the image's tree (same
// versions, zero registry), and an app that later needs an extra
// installs just that extra ALONGSIDE the links — the core links are
// untouched. A whole-dir link would be the wrong shape: installing an
// extra would replace it and orphan the core stack.
//
// Node resolves each link to its real path before looking up transitive
// deps, so astro's vite/rollup/etc. resolve through the repo's
// node_modules — nothing more is needed. Re-runnable (refreshes links);
// refuses to overwrite a REAL directory or file sitting where a link
// belongs (an install that materialized one — see README).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureRoot, '..', '..', '..');

// The core stack the fixture imports (keep in lockstep with
// package.json's dependencies — the app's own declaration). The two
// @lit-labs shims back the vendored SSR renderer (astro.config's alias
// block) — part of the stack's closure, same resolution shape.
const PACKAGES = [
  'astro',
  'zod',
  'lit',
  'lit-element',
  '@lit-labs/ssr-dom-shim',
  '@astrojs/node',
  '@awesome.me/astro-lit',
  '@awesome.me/webawesome',
];
// The build entry the npm scripts use (astro's bin, via the repo's .bin).
const BINS = ['astro'];

let failures = 0;
const place = (name) => {
  const target = path.join(repoRoot, 'node_modules', name);
  const link = path.join(fixtureRoot, 'node_modules', name);
  if (!fs.existsSync(target)) {
    console.error(`setup-node-modules: ${target} does not exist — run npm ci in the repo first`);
    failures++;
    return;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const existing = fs.lstatSync(link, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    console.error(
      `setup-node-modules: ${link} exists and is not a symlink — an install replaced the per-package shape; remove it and re-run`,
    );
    failures++;
    return;
  }
  if (existing) fs.rmSync(link); // refresh (retarget after a move)
  // 'junction' type: Windows needs it; POSIX ignores the type entirely
  fs.symlinkSync(path.relative(path.dirname(link), target), link, 'junction');
  console.log(`linked ${path.relative(fixtureRoot, link)} -> ${path.relative(fixtureRoot, target)}`);
};

for (const name of PACKAGES) place(name);

fs.mkdirSync(path.join(fixtureRoot, 'node_modules', '.bin'), { recursive: true });
for (const bin of BINS) {
  const target = path.join(repoRoot, 'node_modules', '.bin', bin);
  const link = path.join(fixtureRoot, 'node_modules', '.bin', bin);
  if (!fs.existsSync(target)) {
    console.error(`setup-node-modules: ${target} does not exist — run npm ci in the repo first`);
    failures++;
    continue;
  }
  const existing = fs.lstatSync(link, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    console.error(`setup-node-modules: ${link} exists and is not a symlink — remove it and re-run`);
    failures++;
    continue;
  }
  if (existing) fs.rmSync(link);
  fs.symlinkSync(path.relative(path.dirname(link), target), link, 'junction');
  console.log(`linked bin ${bin}`);
}

if (failures > 0) process.exit(1);
console.log('fixture node_modules ready (per-package symlinks into the repo tree)');
