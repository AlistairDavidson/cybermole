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
// classic client-side JS (a terminal cannot be SSR'd — CODE_STYLE.md §7).
// The exemption matches FILE NAMES (agent-console*.ts), not substrings —
// code, not a marker an agent could sprinkle.
import * as fs from 'node:fs';
import * as path from 'node:path';

const SANCTIONED_RE = /(?:^|[\\/])agent-console[-.]/;

const BANNED_IMPORTS = [
  {
    re: /^(preact|preact\/.*|@preact\/signals)$/,
    why: 'preact the renderer is banned — Astro components + HTML web components + @preact/signals-core (CODE_STYLE.md §7)',
  },
  {
    re: /^(@astrojs\/react|@astrojs\/preact|@astrojs\/svelte|@astrojs\/solid-js|@astrojs\/vue)$/,
    why: 'renderer integrations are banned — SSR is Astro itself; client behaviour is HTML web components',
  },
  {
    re: /^(react|react-dom|svelte|solid-js|vue|htmx(\.org)?|htm|uhtml)$/,
    why: 'client renderers/templates are banned — effects update the DOM surgically, never from HTML strings',
  },
  {
    re: /^(lit|lit-html|lit-element|@lit-labs\/.*)$/,
    why: 'lit directly is banned — wa-* leaves come from @awesome.me/webawesome component paths',
  },
];

const IMPORT_RE = /^\s*import\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/;
const EXPORT_FROM_RE = /^\s*export\s+[^'";]*?\sfrom\s+['"]([^'"]+)['"]/;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const ATTACH_SHADOW_RE = /\.attachShadow\s*\(/;
const CREATE_ELEMENT_RE = /\bdocument\.createElement\s*\(/;
/** Whole-source (multi-line writes too); line numbers mapped after. */
const HTML_WRITE_RE =
  /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\.(?:insertAdjacentHTML|setHTMLUnsafe)\s*\(|\bdocument\.write\s*\(/g;
/** Inline style attributes in .astro markup — Web Awesome or tokens, not style=. */
const STYLE_ATTR_RE = /\sstyle\s*=\s*["{]/;
const CLIENT_DIRECTIVE_RE = /\bclient:(?:load|visible|idle|only|media)\b/;
const DEFINE_RE = /\bcustomElements\.define\s*\(/;
const GUARD_RE = /\bcustomElements\.get\s*\(/;

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

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
    if (CREATE_ELEMENT_RE.test(line)) {
      violations.push(
        `${rel}:${lineNo}: document.createElement — repeated markup is templated in the .astro (<template> + fill/clone), never constructed in TS (CODE_STYLE.md §7)`,
      );
    }
    if (/\.astro$/.test(rel) && STYLE_ATTR_RE.test(line)) {
      violations.push(
        `${rel}:${lineNo}: inline style attribute — Web Awesome layout components, utility classes and tokens are the styling surface (CODE_STYLE.md §7)`,
      );
    }
    if (/\.astro$/.test(rel) && CLIENT_DIRECTIVE_RE.test(line)) {
      violations.push(
        `${rel}:${lineNo}: client:* directive — hydration is banned; SSR the content and enhance it (CODE_STYLE.md §7)`,
      );
    }
  });
  // HTML writes match whole-source (multi-line assignments too), reported
  // at the line each match starts on.
  for (const m of source.matchAll(HTML_WRITE_RE)) {
    violations.push(
      `${rel}:${lineOf(source, m.index ?? 0)}: HTML-string write (innerHTML/outerHTML/insertAdjacentHTML/setHTMLUnsafe/document.write) — update the DOM surgically, never from HTML strings`,
    );
  }
  if (DEFINE_RE.test(source) && !GUARD_RE.test(source)) {
    violations.push(
      `${rel}: customElements.define without a customElements.get guard — use defineElement from @cybermole/app-kit/element`,
    );
  }
  return violations;
}

const SCAN_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.astro']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-server', '.astro', 'vendor', '.git']);

/** §7's component-directory rule, checked structurally: a component is a
 *  directory src/components/<Name>/ holding <Name>.astro + <name>.ts. */
export function scanComponentDir(componentsDir) {
  const violations = [];
  let entries;
  try {
    entries = fs.readdirSync(componentsDir, { withFileTypes: true });
  } catch {
    return violations;
  }
  for (const entry of entries) {
    const p = path.join(componentsDir, entry.name);
    if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      violations.push(
        `${p}: a flat file in components/ — a component is a directory <Name>/ holding <Name>.astro + <name>.ts (CODE_STYLE.md §7)`,
      );
    } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      if (!fs.existsSync(path.join(p, `${entry.name}.astro`))) {
        violations.push(
          `${p}: a component directory without ${entry.name}.astro — the SSR half of the pair is missing (CODE_STYLE.md §7)`,
        );
      }
    }
  }
  return violations;
}

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
      if (entry.name === 'components') {
        violations.push(...scanComponentDir(p));
      }
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
