#!/usr/bin/env node
// The apps' architecture lint (CODE_STYLE.md §7), applied to the console's
// own src/ as a ratchet: LEGACY lists the files still on the old
// patterns, with the violation count each may not exceed. A new file, or a
// legacy file gaining a violation, fails; a legacy file that improved
// fails too until its entry is lowered (or removed), so the list only
// shrinks. Runs as the tail of `npm run lint`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanComponentDir, scanSource } from '../packages/app-kit/scripts/arch-check.mjs';

/** file (or component dir) → violations it is allowed. Lower, never raise. */
const LEGACY = new Map([
  ['src/components/AgentTerminal/agent-terminal.ts', 6],
  ['src/components/AppSettings', 1],
  ['src/components/console-events.ts', 1],
  ['src/components/editor-pane.ts', 1],
  ['src/components/form', 1],
  ['src/components/html.ts', 4],
  ['src/components/JobsApp/jobs-app.ts', 5],
  ['src/components/jobs-events.ts', 1],
  ['src/components/Settings', 1],
  ['src/components/signed-in-fetch.ts', 1],
  ['src/components/workspace-sidebar.ts', 4],
  ['src/layouts/Base.astro', 1],
]);

const SCAN_EXT = new Set(['.ts', '.mjs', '.js', '.astro']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'components') out.push(...scanComponentDir(p));
      walk(p, out);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(...scanSource(p, fs.readFileSync(p, 'utf8')));
    }
  }
}

const violations = [];
walk('src', violations);

/** A violation line starts `<file>:<line>: ` or `<dir>: `. */
const subjectOf = v => v.slice(0, v.indexOf(': ')).replace(/:\d+$/, '');
const counts = new Map();
for (const v of violations) counts.set(subjectOf(v), (counts.get(subjectOf(v)) ?? 0) + 1);

const failures = [];
for (const [subject, n] of counts) {
  const allowed = LEGACY.get(subject) ?? 0;
  if (n > allowed) {
    failures.push(`${subject}: ${n} violation(s), ${allowed} allowed`);
    for (const v of violations) if (subjectOf(v) === subject) failures.push(`  ${v}`);
  }
}
for (const [subject, allowed] of LEGACY) {
  const n = counts.get(subject) ?? 0;
  if (n < allowed)
    failures.push(
      `${subject}: down to ${n} from ${allowed} — lower its LEGACY entry in ${path.basename(import.meta.filename)}`,
    );
}

if (failures.length > 0) {
  console.error(
    'arch-check (console): the component standard (CODE_STYLE.md §7) regressed or improved',
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`arch-check (console): ok — ${LEGACY.size} legacy entries left`);
