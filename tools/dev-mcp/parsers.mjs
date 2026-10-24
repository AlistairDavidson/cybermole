// parsers.mjs — the pure output-shaping half of the dev test-MCP
// (docs/dev-test-mcp-plan.md §4–§5): bounded-output helpers and the
// machine-format parsers for ESLint's and Playwright's JSON reports, plus
// the anchor-quiet shaping for the error-only text runners (astro
// check/tsc/astro build). No node imports, no side effects — everything
// here is unit-tested against checked-in fixtures (tests/unit/fixtures/,
// tests/unit/dev-mcp.test.mjs).
//
// Every parser answers null on anything unexpected instead of throwing:
// the tools then fall back to the bounded raw-output tail — the anchor-miss
// fallback in another shape (plan §1.3/§4). Where we can do better than
// barbarus's regex anchoring we do: these runners emit machine formats
// natively, so quiet mode is parsing, not pattern-matching.

// §1.5: bounded output — 64 KiB cap keeping head + tail (early parse
// errors and trailing summary are the parts that matter) around an
// explicit omission marker.
export const OUTPUT_LIMIT = 65536;
// Per-failure error text cap (~2 KiB, plan §4 Playwright note).
export const FAILURE_ERROR_LIMIT = 2048;

/** Keep head + tail of text around an explicit `…[N chars omitted]…`
 *  marker. Under the cap the text passes through unchanged. */
export function trimOutput(text, max = OUTPUT_LIMIT) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${omitted} chars omitted]…\n${s.slice(-tail)}`;
}

/** The last n non-empty lines of text (crash tails, stderr tails). */
export function tailLines(text, n = 20) {
  const lines = String(text ?? '')
    .split('\n')
    .filter(l => l.trim() !== '');
  return lines.slice(-n).join('\n');
}

// ---------- the anchor-quiet shaping for error-only text runners ----------
//
// astro check / tsc / astro build print error-only text: diagnostics (if
// any) followed by a result line. Quiet keeps error-looking lines plus the
// trailing summary and drops the boot/progress noise; if the process died
// without a result line the tail is what's kept — barbarus's no-banner
// fallback, same rationale (the cause stays visible).

// Boot noise: the [types]/[@astrojs/node] warm-up lines every astro
// command prints before doing anything, timestamps and all.
const BOOT_NOISE_RE = /^\d\d:\d\d:\d\d \[(?:types|@astrojs\/node)\]/;

/** A line that looks like a diagnostic. `- 0 errors` summary lines contain
 *  the word too — they are summaries, not errors, and sit in the kept tail
 *  anyway. tsc (`src/x.ts:12:3: error TS2345: …`) and astro check
 *  (`src/x.astro:1:1 - error …`) diagnostics match; vite failures lead
 *  with ✖. */
function looksLikeError(line) {
  if (/\b0 errors?\b/i.test(line)) return false;
  return /\berror\b/i.test(line) || line.includes('✖');
}

/** Anchor-quiet shaping: error lines + the last keepTail non-empty lines
 *  (the result line lives there), boot noise dropped, trailing whitespace
 *  trimmed, output bounded. */
export function anchorQuiet(text, { keepTail = 5 } = {}) {
  const lines = String(text ?? '')
    .split('\n')
    .filter(l => !BOOT_NOISE_RE.test(l));
  const keep = new Set();
  lines.forEach((line, i) => {
    if (line.trim() !== '' && looksLikeError(line)) keep.add(i);
  });
  const nonEmpty = [];
  lines.forEach((line, i) => {
    if (line.trim() !== '') nonEmpty.push(i);
  });
  for (const i of nonEmpty.slice(-keepTail)) keep.add(i);
  return trimOutput(
    lines
      .filter((_, i) => keep.has(i))
      .map(l => l.replace(/\s+$/, ''))
      .join('\n')
      .trimEnd(),
  );
}

/** Strip ANSI escapes — Playwright's JSON report embeds color codes in
 *  error messages even with stdout redirected, and they would ride the
 *  envelope straight into an agent's transcript. */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
export function stripAnsi(text) {
  return String(text ?? '').replaceAll(ANSI_RE, '');
}

// ---------- ESLint (--format json) ----------

/** Parse an ESLint JSON report into the shared vocabulary. counts is
 *  lint-shaped ({files, errors, warnings, fixable}); failures[] carries
 *  every error message in full with its file and position, warnings stay
 *  per-file counts (warningsByFile) — plan §3. null when the text is not
 *  an ESLint report. */
export function parseEslintJson(text, root = '') {
  let report;
  try {
    report = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  if (!Array.isArray(report)) return null;
  const rel = p => {
    if (typeof p !== 'string') return '';
    if (root !== '' && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
    return p;
  };
  const counts = { files: 0, errors: 0, warnings: 0, fixable: 0 };
  const failures = [];
  const warningsByFile = [];
  for (const f of report) {
    if (f === null || typeof f !== 'object' || !Array.isArray(f.messages)) continue;
    counts.files += 1;
    counts.errors += f.errorCount ?? 0;
    counts.warnings += f.warningCount ?? 0;
    counts.fixable += (f.fixableErrorCount ?? 0) + (f.fixableWarningCount ?? 0);
    for (const m of f.messages) {
      if ((m?.severity ?? 1) === 2) {
        const at = `${m.line ?? 0}:${m.column ?? 0}`;
        const rule = m.ruleId ? ` (${m.ruleId})` : '';
        failures.push({ name: rel(f.filePath), error: `${at}  ${m.message}${rule}` });
      }
    }
    if ((f.warningCount ?? 0) > 0) {
      warningsByFile.push(
        `${rel(f.filePath)}: ${f.warningCount} warning${f.warningCount === 1 ? '' : 's'}`,
      );
    }
  }
  return { counts, failures, warningsByFile };
}

// ---------- Playwright (--reporter=json) ----------

/** Parse a Playwright JSON report (the file PLAYWRIGHT_JSON_OUTPUT_NAME
 *  pointed at — never stdout, which carries the web-server's stderr).
 *  counts from `stats`; failures[] from tests whose status is not a pass:
 *  unexpected (the real failures), flaky (passed on retry — nondeterminism
 *  worth seeing), interrupted, didNotRun — each with the failing result's
 *  error message/snippet, trimmed per-failure. Root-level `errors[]`
 *  (globalSetup/web-server failures) ride globalErrors[]. null when the
 *  text is not a report — the caller falls back to the raw tail. */
export function parsePlaywrightJson(text, root = '') {
  let report;
  try {
    report = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  if (report === null || typeof report !== 'object' || !report.stats) return null;
  const st = report.stats;
  const rel = p => {
    if (typeof p !== 'string') return '';
    if (root !== '' && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
    return p;
  };
  const counts = {
    pass: st.expected ?? 0,
    fail: st.unexpected ?? 0,
    flaky: st.flaky ?? 0,
    skipped: st.skipped ?? 0,
    didNotRun: st.didNotRun ?? 0,
    interrupted: st.interrupted ?? 0,
  };
  const failures = [];
  const titles = []; // suite title chain; the root suite's title is the file
  const walk = suite => {
    if (suite === null || typeof suite !== 'object') return;
    if (typeof suite.title === 'string' && suite.title !== '') titles.push(suite.title);
    for (const spec of suite.specs ?? []) {
      if (spec === null || typeof spec !== 'object') continue;
      for (const t of spec.tests ?? []) {
        if (t === null || typeof t !== 'object') continue;
        const marks = {
          unexpected: '',
          flaky: '[flaky] ',
          interrupted: '[interrupted] ',
          didNotRun: '[didNotRun] ',
        };
        if (!Object.hasOwn(marks, t.status)) continue; // expected/skipped: not failures
        const mark = marks[t.status];
        const results = Array.isArray(t.results) ? t.results : [];
        const res =
          results.find(r => ['failed', 'timedOut', 'interrupted'].includes(r?.status)) ??
          results[results.length - 1];
        const err = res?.error ?? {};
        const name =
          [...titles.slice(1), spec.title].filter(part => part !== '').join(' › ') +
            (typeof t.projectName === 'string' && t.projectName !== ''
              ? ` [${t.projectName}]`
              : '') || '(untitled)';
        const file = typeof spec.file === 'string' ? `${rel(spec.file)}:${spec.line ?? 0}` : '';
        const error = trimOutput(
          stripAnsi(
            [err.message, err.snippet].filter(v => typeof v === 'string' && v !== '').join('\n'),
          ),
          FAILURE_ERROR_LIMIT,
        );
        failures.push({ name: `${mark}${name}`, file, error });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
    if (typeof suite.title === 'string' && suite.title !== '') titles.pop();
  };
  for (const s of report.suites ?? []) walk(s);
  const globalErrors = (Array.isArray(report.errors) ? report.errors : [])
    .map(e =>
      trimOutput(stripAnsi(typeof e?.message === 'string' ? e.message : ''), FAILURE_ERROR_LIMIT),
    )
    .filter(m => m !== '');
  return { counts, failures, globalErrors };
}

// ---------- the unit runner's machine line ----------
//
// quiet-reporter.mjs ends its stdout with one single-line JSON object
// (counts + failures) prefixed @@devmcp — our own format, so quiet mode
// here is parsing, never pattern-matching (plan §1 "where no flag exists"
// does not apply: the reporter is ours and emits the summary itself).

export const MACHINE_LINE_PREFIX = '@@devmcp ';

/** The last valid @@devmcp line's parsed object, or null (reporter missing
 *  or mangled — the caller falls back to returncode + raw text). */
export function extractUnitSummary(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(MACHINE_LINE_PREFIX)) continue;
    try {
      const parsed = JSON.parse(lines[i].slice(MACHINE_LINE_PREFIX.length));
      if (parsed !== null && typeof parsed === 'object' && parsed.counts) return parsed;
    } catch {
      // keep looking — a stale or partial line earlier is not the answer
    }
  }
  return null;
}

/** The quiet text minus the machine lines (they are structure, not prose). */
export function stripMachineLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter(l => !l.startsWith(MACHINE_LINE_PREFIX))
    .join('\n');
}
