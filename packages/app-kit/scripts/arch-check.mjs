#!/usr/bin/env node
// The architecture lint (CODE_STYLE.md §7): the component standard's
// mechanical rules, checked as plain source scans so any tree can run it
// with plain node — no eslint install, no parser. Apps run it as their
// `lint:arch` script (a stage of the apps check verb); anywhere else:
//   node <kit>/scripts/arch-check.mjs src [more dirs...]
// Rules:
//   - banned imports: the preact renderer in any form (preact, preact/*,
//     @preact/signals — @preact/signals-core is the sanctioned build), lit
//     directly (leaves come from @awesome.me/webawesome paths), htmx.
//   - no attachShadow: shadow DOM belongs to third-party leaves and the
//     agent console, never app-authored elements.
//   - no innerHTML/outerHTML writes: effects update the DOM surgically.
//   - no unguarded customElements.define: use defineElement from
//     @cybermole/app-kit/element.
// Skips node_modules, dist*, .astro, and vendor/ (vendored shims).
// SANCTIONED: the agent console/terminal is the one first-party module of
// classic client-side JS (a terminal cannot be SSR'd — CODE_STYLE.md §7);
// its file names are exempt, and the exemption is code, not a marker an
// agent could sprinkle.
import * as fs from 'node:fs';
import * as path from 'node:path';

const SANCTIONED_RE = /agent-console/;

const BANNED_IMPORTS = [
  {
    re: /^(preact|preact\/.*)$/,
    why: 'preact the renderer is banned — Astro components + HTML web components + @preact/signals-core (CODE_STYLE.md §7)',
  },
  {
    re: /^@preact\/signals$/,
    why: 'use @preact/signals-core — the preact-integrated build pulls the renderer',
  },
  {
    re: /^(lit|lit-html|lit-element|@lit-labs\/.*)$/,
    why: 'lit directly is banned — wa-* leaves come from @awesome.me/webawesome component paths',
  },
  { re: /^htmx(\.org)?$/, why: 'no fetch-and-swap — enhancers update the DOM surgically' },
];

const IMPORT_RE = /^\s*import\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/;
const EXPORT_FROM_RE = /^\s*export\s+[^'";]*?\sfrom\s+['"]([^'"]+)['"]/;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const ATTACH_SHADOW_RE = /\.attachShadow\s*\(/;
const HTML_WRITE_RE = /\.(?:innerHTML|outerHTML)\s*=[^=]/;
const DEFINE_RE = /\bcustomElements\.define\s*\(/;
const GUARD_RE = /\bcustomElements\.get\s*\(/;

/** One file's violations, `${rel}:${line}: why` per line. */
export function scanSource(rel, source) {
  if (SANCTIONED_RE.test(rel)) return [];
  const violations = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    for (const re of [IMPORT_RE, EXPORT_FROM_RE]) {
      const m = re.exec(line);
      if (m !== null) {
        const banned = BANNED_IMPORTS.find(b => b.re.test(m[1]));
        if (banned !== undefined)
          violations.push(`${rel}:${lineNo}: import '${m[1]}' — ${banned.why}`);
      }
    }
    for (const m of line.matchAll(DYNAMIC_IMPORT_RE)) {
      const banned = BANNED_IMPORTS.find(b => b.re.test(m[1]));
      if (banned !== undefined)
        violations.push(`${rel}:${lineNo}: import '${m[1]}' — ${banned.why}`);
    }
    if (ATTACH_SHADOW_RE.test(line)) {
      violations.push(
        `${rel}:${lineNo}: attachShadow — app-authored elements are light DOM only (CODE_STYLE.md §7)`,
      );
    }
    if (HTML_WRITE_RE.test(line)) {
      violations.push(
        `${rel}:${lineNo}: innerHTML/outerHTML write — update the DOM surgically, never from HTML strings`,
      );
    }
  });
  if (DEFINE_RE.test(source) && !GUARD_RE.test(source)) {
    violations.push(
      `${rel}: customElements.define without a customElements.get guard — use defineElement from @cybermole/app-kit/element`,
    );
  }
  return violations;
}

const SCAN_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.astro']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-server', '.astro', 'vendor', '.git']);

function walk(dir, violations) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(p, violations);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      violations.push(...scanSource(p, fs.readFileSync(p, 'utf8')));
    }
  }
}

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('arch-check: pass the dirs to scan (usually src)');
    process.exit(2);
  }
  const violations = [];
  for (const dir of dirs) walk(dir, violations);
  if (violations.length > 0) {
    console.error(`arch-check: ${violations.length} violation(s)`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log('arch-check: ok');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) main();
