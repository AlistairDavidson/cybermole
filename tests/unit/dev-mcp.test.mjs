// dev-mcp.test.mjs — the dev test-MCP's own units (docs/plans/dev-test-mcp-plan.md
// §7): the pure parsers against checked-in fixture blobs (a real captured
// Playwright JSON report and an ESLint JSON report under fixtures/), the
// envelope/trim edge cases, the anchor/tail fallbacks, and smoke runs of
// quiet-reporter.mjs itself (passing, failing, file-crash and name-pattern
// shapes) through the same child-process spawn run_unit_tests uses. The
// stdio server (tools/dev-mcp/server.mjs) stays registration glue — thin
// enough not to need its own harness, unlike server/mcp.ts's verbatim-proxy
// contract (mcp.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FAILURE_ERROR_LIMIT,
  MACHINE_LINE_PREFIX,
  OUTPUT_LIMIT,
  anchorQuiet,
  extractUnitSummary,
  parseEslintJson,
  parsePlaywrightJson,
  stripMachineLines,
  tailLines,
  trimOutput,
} from '../../tools/dev-mcp/parsers.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const fixture = name => fs.readFileSync(path.join(REPO, 'tests/unit/fixtures', name), 'utf8');
const REPORTER = path.join(REPO, 'tools/dev-mcp/quiet-reporter.mjs');

// ---------- trimOutput / tailLines (the bounded-output contract, §1.5) ----------

test('trimOutput: under the cap passes through; over it keeps head + tail around the marker', () => {
  assert.equal(trimOutput('short'), 'short');
  assert.equal(trimOutput(''), '');
  const text = `${'a'.repeat(500)}\nmiddle\n${'z'.repeat(500)}`;
  const out = trimOutput(text, 100);
  assert.match(out, /…\[\d+ chars omitted\]…/);
  const marker = out.match(/…\[(\d+) chars omitted\]…/);
  const markerText = `…[${marker[1]} chars omitted]…`;
  // out = head + '\n' + marker + '\n' + tail, so kept + omitted = original
  const kept = out.length - markerText.length - 2;
  assert.equal(kept + Number(marker[1]), text.length);
  assert.ok(out.startsWith('a'));
  assert.ok(out.endsWith('z'));
});

test('trimOutput: exactly at the cap is untouched', () => {
  const text = 'x'.repeat(OUTPUT_LIMIT);
  assert.equal(trimOutput(text), text);
});

test('tailLines: the last non-empty lines', () => {
  assert.equal(tailLines('a\n\nb\nc\n\n', 2), 'b\nc');
  assert.equal(tailLines('', 5), '');
});

// ---------- anchorQuiet (astro check / tsc / astro build text, §4) ----------

test('anchorQuiet: astro check success — boot noise dropped, result summary kept', () => {
  const out = anchorQuiet(
    [
      '00:26:40 [@astrojs/node] Enabling sessions with filesystem storage',
      '00:26:40 [types] Generated 38ms',
      '00:26:40 [check] Getting diagnostics for Astro files in /repo...',
      'Result (108 files): ',
      '- 0 errors',
      '- 0 warnings',
      '- 0 hints',
      '',
    ].join('\n'),
  );
  assert.equal(
    out,
    [
      '00:26:40 [check] Getting diagnostics for Astro files in /repo...',
      'Result (108 files):',
      '- 0 errors',
      '- 0 warnings',
      '- 0 hints',
    ].join('\n'),
  );
});

test('anchorQuiet: tsc diagnostics are kept, "- 0 errors" summaries are not errors', () => {
  const out = anchorQuiet(
    [
      'src/lib/x.ts:12:3 - error TS2345: Argument of type is not assignable',
      'Result: 0 errors',
    ].join('\n'),
  );
  assert.match(out, /src\/lib\/x\.ts:12:3 - error TS2345/);
  assert.match(out, /Result: 0 errors/);
});

test('anchorQuiet: a dead process with no result line keeps the tail (the no-banner fallback)', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `progress ${i}`);
  lines.push('Segmentation fault (core dumped)');
  const out = anchorQuiet(lines.join('\n'));
  assert.match(out, /Segmentation fault/);
  assert.ok(out.length < lines.join('\n').length);
});

// ---------- parseEslintJson (fixture: 2 errors, 1 warning, 1 fixable, 3 files) ----------

test('parseEslintJson: counts, full error entries, per-file warnings, root-relative paths', () => {
  const parsed = parseEslintJson(fixture('eslint-report.json'), '/repo');
  assert.deepEqual(parsed.counts, { files: 3, errors: 2, warnings: 1, fixable: 1 });
  assert.deepEqual(
    parsed.failures.map(f => f.name),
    ['src/lib/broken.ts', 'src/pages/meh.ts'],
  );
  assert.ok(
    parsed.failures[0].error.startsWith(
      "12:7  'orphan' is defined but never used. (no-unused-vars)",
    ),
  );
  assert.ok(parsed.failures[1].error.startsWith('8:22  Missing semicolon. (semi)'));
  assert.deepEqual(parsed.warningsByFile, ['src/pages/meh.ts: 1 warning']);
});

test('parseEslintJson: null on non-reports, zero counts on an empty report', () => {
  assert.equal(parseEslintJson('not json'), null);
  assert.equal(parseEslintJson('{"a":1}'), null);
  const empty = parseEslintJson('[]');
  assert.deepEqual(empty.counts, { files: 0, errors: 0, warnings: 0, fixable: 0 });
  assert.deepEqual(empty.failures, []);
});

// ---------- parsePlaywrightJson (fixture: a real captured report — 1 pass,
// 1 nested failure under a describe, 1 skip, the chromium project) ----------

test('parsePlaywrightJson: stats counts, suite-path titles, file:line, trimmed error text', () => {
  const parsed = parsePlaywrightJson(fixture('playwright-report.json'), '/repo');
  assert.equal(parsed.counts.pass, 1);
  assert.equal(parsed.counts.fail, 1);
  assert.equal(parsed.counts.skipped, 1);
  assert.equal(parsed.counts.flaky, 0);
  assert.equal(parsed.failures.length, 1);
  const f = parsed.failures[0];
  assert.equal(f.name, 'a suite › nested fail [chromium]');
  assert.match(f.file, /^sample\.spec\.ts:\d+$/);
  assert.match(f.error, /Expected: 2/);
  assert.ok(f.error.length <= FAILURE_ERROR_LIMIT);
  assert.deepEqual(parsed.globalErrors, []);
});

test('parsePlaywrightJson: flaky/interrupted/didNotRun are marked failures, skipped is not', () => {
  const mk = () => ({
    stats: { expected: 0, unexpected: 0, flaky: 1, skipped: 1, interrupted: 1, didNotRun: 1 },
    suites: [
      {
        title: 'file.spec.ts',
        specs: [
          {
            title: 'the flaky one',
            line: 1,
            file: 'file.spec.ts',
            tests: [{ status: 'flaky', results: [{ status: 'passed' }] }],
          },
          {
            title: 'cut short',
            line: 2,
            file: 'file.spec.ts',
            tests: [
              {
                status: 'interrupted',
                results: [{ status: 'interrupted', error: { message: 'Test was interrupted' } }],
              },
            ],
          },
          {
            title: 'never got there',
            line: 3,
            file: 'file.spec.ts',
            tests: [{ status: 'didNotRun', results: [] }],
          },
          {
            title: 'fine',
            line: 4,
            file: 'file.spec.ts',
            tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
          },
          {
            title: 'meh',
            line: 5,
            file: 'file.spec.ts',
            tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }],
          },
        ],
      },
    ],
  });
  const parsed = parsePlaywrightJson(JSON.stringify(mk()));
  assert.deepEqual(
    parsed.failures.map(f => f.name),
    ['[flaky] the flaky one', '[interrupted] cut short', '[didNotRun] never got there'],
  );
  assert.match(parsed.failures[1].error, /interrupted/);
});

test('parsePlaywrightJson: root-level errors ride globalErrors; null on non-reports', () => {
  const withGlobal = JSON.stringify({
    stats: { expected: 0 },
    errors: [{ message: 'WebServer failed' }],
  });
  assert.deepEqual(parsePlaywrightJson(withGlobal).globalErrors, ['WebServer failed']);
  assert.equal(parsePlaywrightJson('garbage'), null);
  assert.equal(parsePlaywrightJson('{"suites": []}'), null); // no stats
});

// ---------- the machine line ----------

test('extractUnitSummary / stripMachineLines: the last @@devmcp line is the structure, the rest is prose', () => {
  const text = [
    '✖ broken (tests/unit/x.test.mjs:9) 3.2ms',
    '    the message',
    '# tests 5 | pass 4 | fail 1 | skipped 0 | todo 0 | cancelled 0',
    `${MACHINE_LINE_PREFIX}${JSON.stringify({ counts: { pass: 4, fail: 1, skipped: 0, todo: 0, cancelled: 0 }, failures: [{ name: 'broken' }], success: false })}`,
  ].join('\n');
  const summary = extractUnitSummary(text);
  assert.equal(summary.success, false);
  assert.equal(summary.counts.fail, 1);
  assert.equal(summary.failures[0].name, 'broken');
  // a mangled last line falls back to an earlier valid one
  assert.equal(extractUnitSummary(`${text}\n${MACHINE_LINE_PREFIX}{oops`).counts.fail, 1);
  assert.equal(extractUnitSummary('no machine line at all'), null);
  assert.ok(!stripMachineLines(text).includes(MACHINE_LINE_PREFIX));
  assert.match(stripMachineLines(text), /# tests 5/);
});

// ---------- quiet-reporter smoke runs (the §7 spawn harness) ----------

/** Spawn the runner the way run_unit_tests does — including the
 *  NODE_TEST_CONTEXT sanitization the server's children get — and resolve
 *  {code, stdout, stderr}. */
function runReporter(args) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // a stray marker neuters node:test's run()
    const child = spawn(process.execPath, [REPORTER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => {
      stdout += c;
    });
    child.stderr.on('data', c => {
      stderr += c;
    });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const summaryOf = stdout => extractUnitSummary(stdout);
const fx = name => path.join(REPO, 'tests/unit/fixtures', name);

test('quiet-reporter: a passing file is a handful of lines with counts, exit 0', async () => {
  const r = await runReporter([fx('quiet-pass.test.mjs')]);
  assert.equal(r.code, 0, r.stderr);
  const summary = summaryOf(r.stdout);
  assert.equal(summary.success, true);
  assert.deepEqual(summary.counts, { pass: 2, fail: 0, skipped: 1, todo: 0, cancelled: 0 });
  assert.equal(summary.failures, undefined);
  // the quiet contract: the text (minus the machine line) is tiny
  const text = stripMachineLines(r.stdout).trim();
  assert.ok(text.split('\n').length <= 2, `expected a couple of lines, got:\n${text}`);
  assert.match(text, /# tests 3 \| pass 2/);
});

test('quiet-reporter: a failure carries name, file:line, duration and the REAL error message', async () => {
  const r = await runReporter([fx('quiet-fail.test.mjs')]);
  assert.equal(r.code, 1);
  const summary = summaryOf(r.stdout);
  assert.equal(summary.success, false);
  assert.equal(summary.counts.pass, 1);
  assert.equal(summary.counts.fail, 1);
  const f = summary.failures[0];
  assert.equal(f.name, 'the broken one');
  assert.match(f.file, /quiet-fail\.test\.mjs:\d+$/);
  assert.match(f.error, /the quiet reporter must carry this message/);
  assert.ok(typeof f.duration_ms === 'number');
  assert.match(r.stdout, /✖ the broken one/);
});

test('quiet-reporter: a file that crashes at import becomes a failure of its own', async () => {
  const r = await runReporter([fx('quiet-crash.test.mjs')]);
  assert.equal(r.code, 1);
  const summary = summaryOf(r.stdout);
  assert.equal(summary.counts.fail, 1);
  assert.equal(summary.counts.pass, 0);
  const f = summary.failures[0];
  assert.equal(f.name, 'quiet-crash.test.mjs');
  assert.match(f.error, /import exploded/);
});

test("quiet-reporter: --name-pattern narrows, like the ladder's targeted rule", async () => {
  const r = await runReporter([fx('quiet-pass.test.mjs'), '--name-pattern', 'strings']);
  assert.equal(r.code, 0);
  const summary = summaryOf(r.stdout);
  assert.equal(summary.counts.pass, 1);
  assert.equal(summary.counts.skipped, 0);
});

test('quiet-reporter: no files is a usage error', async () => {
  const r = await runReporter([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no test files/);
});
