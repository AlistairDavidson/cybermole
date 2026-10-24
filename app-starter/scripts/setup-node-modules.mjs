#!/usr/bin/env node
// setup-node-modules.mjs — create this app's node_modules as PER-PACKAGE
// SYMLINKS into the cybermole install's node_modules (apps-plan §5's
// resolution shape): the core stack resolves from the image — the same
// versions the console runs, zero registry access — and an app that
// needs an extra installs just that extra ALONGSIDE the links (the core
// links are untouched). A whole-dir link would be the wrong shape:
// installing an extra would replace it and orphan the core stack.
//
// Written into the tree by the cybermole-apps scaffold (the image's
// app-starter template) — RE-RUN it after an image upgrade to refresh
// the links (new core packages appear, stale ones drop), or inside a
// dev checkout where the tree lives under the repo. The install root is
// baked at scaffold time; CYBERMOLE_INSTALL_ROOT overrides it, and a
// walk-up from this script's own location covers trees developed inside
// a checkout.
//
// Re-runnable: existing links are refreshed (retargeted after a move);
// a REAL directory or file sitting where a link belongs is REFUSED with
// a clear line — an npm install replaced the per-package shape; remove
// it and re-run.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The core stack this app imports — keep in lockstep with package.json's
// dependencies (the app's own declaration). @cybermole/app-kit resolves
// to the workspace package; parse5 backs the vendored astro-lit SSR
// renderer (src/vendor/, aliased in astro.config.mjs); @astrojs/check +
// typescript back `astro check`/`tsc`; @preact/signals the island.
const PACKAGES = [
  'astro',
  'zod',
  'lit',
  'lit-element',
  'parse5',
  'preact',
  '@preact/signals',
  '@lit-labs/ssr-dom-shim',
  '@astrojs/node',
  '@astrojs/check',
  'typescript',
  '@awesome.me/astro-lit',
  '@awesome.me/webawesome',
  '@cybermole/app-kit',
];
// The build/check entries the npm scripts use, via the install's .bin.
const BINS = ['astro', 'tsc'];

// Baked by the scaffold (the install that created this tree — in the
// image, /opt/cybermole). The template's placeholder simply fails the
// is-an-install probe below, and the walk-up takes over — the marker
// appears exactly once in this file, so the scaffold's blanket
// substitution cannot corrupt anything else.
const BAKED_INSTALL_ROOT = '__INSTALL_ROOT__';

/** An install root: has astro in its node_modules. */
const isInstall = dir => fs.existsSync(path.join(dir, 'node_modules', 'astro'));

/** Find the cybermole install: an explicit env override, the baked root,
 *  or the nearest ancestor of THIS tree whose node_modules has astro. */
function findInstallRoot() {
  const candidates = [process.env.CYBERMOLE_INSTALL_ROOT, BAKED_INSTALL_ROOT].filter(
    v => typeof v === 'string' && v.trim() !== '',
  );
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (isInstall(root)) return root;
    console.error(`setup-node-modules: ${root} has no node_modules/astro — not a cybermole install`);
  }
  for (let dir = appRoot; ; dir = path.dirname(dir)) {
    if (isInstall(dir)) return dir;
    if (path.dirname(dir) === dir) break; // reached /
  }
  console.error(
    'setup-node-modules: no cybermole install found — set CYBERMOLE_INSTALL_ROOT to the install root',
  );
  return null;
}

const installRoot = findInstallRoot();
let failures = 0;

const place = name => {
  const target = path.join(installRoot, 'node_modules', name);
  const link = path.join(appRoot, 'node_modules', name);
  if (!fs.existsSync(target)) {
    console.error(`setup-node-modules: ${target} does not exist — is this the right install?`);
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
  console.log(`linked ${path.relative(appRoot, link)} -> ${path.relative(appRoot, target)}`);
};

if (installRoot !== null) {
  for (const name of PACKAGES) place(name);

  fs.mkdirSync(path.join(appRoot, 'node_modules', '.bin'), { recursive: true });
  for (const bin of BINS) {
    const target = path.join(installRoot, 'node_modules', '.bin', bin);
    const link = path.join(appRoot, 'node_modules', '.bin', bin);
    if (!fs.existsSync(target)) {
      console.error(`setup-node-modules: ${target} does not exist — run npm ci in the install first`);
      failures++;
      continue;
    }
    const existing = fs.lstatSync(link, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) {
      console.error(
        `setup-node-modules: ${link} exists and is not a symlink — remove it and re-run`,
      );
      failures++;
      continue;
    }
    if (existing) fs.rmSync(link);
    fs.symlinkSync(path.relative(path.dirname(link), target), link, 'junction');
    console.log(`linked bin ${bin}`);
  }
}

if (failures > 0 || installRoot === null) process.exit(1);
console.log(
  `${path.basename(appRoot)} node_modules ready (per-package symlinks into ${installRoot})`,
);
