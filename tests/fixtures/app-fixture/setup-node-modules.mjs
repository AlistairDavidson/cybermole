#!/usr/bin/env node
// Links the fixture's node_modules per package into the repo's, so an app
// can install extras alongside without orphaning the core (as a whole-dir
// link would). Transitive deps resolve through the links' real paths.
// Re-runnable; refuses to overwrite a real directory or file.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureRoot, '..', '..', '..');

// Keep in lockstep with package.json's dependencies. The @lit-labs shims
// back the vendored SSR renderer.
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
  // 'junction' matters on Windows only
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
