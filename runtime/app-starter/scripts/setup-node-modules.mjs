#!/usr/bin/env node
// Links this app's node_modules per package into the cybermole install's,
// so the core stack comes from the image with no registry access. An app
// can npm-install extras alongside; a whole-directory link would be replaced
// by that install and orphan the core. Re-run after an image upgrade.
// Refuses a real directory or file where a link belongs (npm replaced the
// per-package shape): remove it and re-run.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Keep in lockstep with package.json's dependencies.
const PACKAGES = [
  'astro',
  'zod',
  'lit',
  'lit-element',
  'parse5',
  '@preact/signals-core',
  '@lit-labs/ssr-dom-shim',
  '@astrojs/node',
  '@astrojs/check',
  'typescript',
  '@awesome.me/astro-lit',
  '@awesome.me/webawesome',
  '@cybermole/app-kit',
  '@xterm/xterm',
  '@xterm/addon-fit',
  'ws',
  '@playwright/test',
  'playwright',
];
const BINS = ['astro', 'tsc', 'playwright'];

// Baked at scaffold time; CYBERMOLE_INSTALL_ROOT overrides it. The
// unsubstituted template value fails the probe, and the walk-up takes over.
const BAKED_INSTALL_ROOT = '__INSTALL_ROOT__';

const isInstall = dir => fs.existsSync(path.join(dir, 'node_modules', 'astro'));

/** The env override, the baked root, or the nearest ancestor with node_modules/astro. */
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
  if (existing) fs.rmSync(link); // refresh, in case the target moved
  // 'junction' matters on Windows only
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
