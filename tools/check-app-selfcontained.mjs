#!/usr/bin/env node
// check-app-selfcontained.mjs — THE apps-plan §5 build gate (settled on
// the fixture app by branch 1): every non-relative import reachable from
// a built app's dist/server/entry.mjs must be a node builtin — the
// module graph self-contained apart from node:, so serve-time (the app
// host importing the entry) never resolves through a node_modules
// symlink an app's extra install could disturb.
//
// Walks the REAL module graph (entry + its relative-import closure,
// including chunks), ignoring comments (bundlers keep JSDoc @example
// imports in output — those are not imports), and flags every bare
// specifier that is not node:-prefixed or a bare node builtin
// ('buffer', 'fs', … resolve identically to their node: spelling).
//
// Usage: node tools/check-app-selfcontained.mjs <dist/server/entry.mjs>
// Exit 0: self-contained. Exit 1: offenders listed (specifier + file).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as module from 'node:module';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (entry === undefined) {
  console.error('usage: node tools/check-app-selfcontained.mjs <dist/server/entry.mjs>');
  process.exit(1);
}
const root = path.resolve(entry);

/** Strip block comments and line comments — build output keeps JSDoc
 *  examples whose `from '...'` lines are not real imports. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every import specifier in a module's code: static (…from 'x', import
 *  'x', export … from 'x') and literal dynamic (import('x')). Computed
 *  specifiers (from `${…}` / import(`${…}`)) carry no literal — skipped
 *  (the `${import.meta.url}` self-references build output uses). */
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
      // a directory import would resolve via package.json/index — build
      // output always names files, so treat a directory as an offender.
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
      'resolve.alias to an inlinable copy — see tests/fixtures/app-fixture/astro.config.mjs).',
  );
  process.exit(1);
}
console.log(
  `self-contained: ${files} module(s), ${(bytes / 1024).toFixed(0)} KiB reachable from ${entry} — ` +
    'only node: builtins and relative imports',
);
