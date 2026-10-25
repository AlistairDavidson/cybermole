#!/usr/bin/env node
// Build gate: every non-relative import reachable from dist/server/entry.mjs
// must be a node builtin, so the app host never resolves through a
// node_modules symlink at serve time. A copy of the repo's
// tools/check-app-selfcontained.mjs (the image ships no tools/); keep them
// in sync.
//
// Usage: node scripts/check-selfcontained.mjs <dist/server/entry.mjs>
// Exit 0: self-contained. Exit 1: offenders listed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as module from 'node:module';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (entry === undefined) {
  console.error('usage: node scripts/check-selfcontained.mjs <dist/server/entry.mjs>');
  process.exit(1);
}
const root = path.resolve(entry);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Static and literal dynamic imports. Computed specifiers (`${import.meta.url}`
 *  self-references) carry no literal and are skipped. */
function importSpecifiers(src) {
  const code = stripComments(src);
  const out = new Set();
  const quoted = /(?:\bfrom|\bimport)\s*(['"])([^'"\n]+)\1/g;
  for (const m of code.matchAll(quoted)) {
    if (!/[$ {]/.test(m[2])) out.add(m[2]); // ${…} templates are not literals
  }
  const dynamic = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  for (const m of code.matchAll(dynamic)) {
    if (!/[$ {]/.test(m[2])) out.add(m[2]);
  }
  return out;
}

const BUILTINS = new Set(module.builtinModules);
const seen = new Set();
const offenders = [];
let files = 0;
let bytes = 0;

function walk(file) {
  const key = path.resolve(file);
  if (seen.has(key)) return;
  seen.add(key);
  let src;
  try {
    src = fs.readFileSync(key, 'utf8');
  } catch (err) {
    offenders.push({ file, spec: null, why: `unreadable: ${err.message}` });
    return;
  }
  files++;
  bytes += Buffer.byteLength(src);
  for (const spec of importSpecifiers(src)) {
    if (spec.startsWith('node:')) continue;
    if (BUILTINS.has(spec)) continue; // bare builtin ('buffer' ≡ node:buffer)
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const resolved = new URL(spec, pathToFileURL(key)).pathname;
      const onDisk =
        fs.existsSync(resolved) ||
        fs.existsSync(`${resolved}.mjs`) ||
        fs.existsSync(`${resolved}.js`);
      if (!onDisk) {
        offenders.push({
          file: path.relative(root, key) || key,
          spec,
          why: 'relative import not on disk',
        });
        continue;
      }
      // Build output always names files; a directory import is an offender.
      walk(fs.statSync(resolved).isDirectory() ? path.join(resolved, 'index.js') : resolved);
      continue;
    }
    offenders.push({
      file: path.relative(path.dirname(root), key),
      spec,
      why: 'bare non-builtin import',
    });
  }
}

walk(root);

if (offenders.length > 0) {
  console.error(`NOT self-contained — ${offenders.length} offender(s) reachable from ${entry}:`);
  for (const o of offenders) {
    console.error(`  ${o.spec ?? '(file)'}  [${o.why}]  in ${o.file}`);
  }
  console.error(
    'Pin offenders with vite.ssr.noExternal (and, for force-externalized entries,\n' +
      'resolve.alias to an inlinable copy — see astro.config.mjs in this tree).',
  );
  process.exit(1);
}
console.log(
  `self-contained: ${files} module(s), ${(bytes / 1024).toFixed(0)} KiB reachable from ${entry} — ` +
    'only node: builtins and relative imports',
);
