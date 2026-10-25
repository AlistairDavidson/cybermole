// Pure output shaping for the dev MCP: bounded output, parsers for ESLint's
// and Playwright's JSON reports, and quiet filtering for the text-only
// runners (astro check, tsc, astro build). Parsers answer null on anything
// unexpected, and the tools fall back to the raw output tail.

// 64 KiB cap, keeping head and tail (early parse errors and the trailing
// summary are what matter).
export const OUTPUT_LIMIT = 65536;
// Per-failure error text cap.
export const FAILURE_ERROR_LIMIT = 2048;

/** Under the cap the text passes through unchanged. */
export function trimOutput(text, max = OUTPUT_LIMIT) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${omitted} chars omitted]…\n${s.slice(-tail)}`;
}

export function tailLines(text, n = 20) {
  const lines = String(text ?? '')
    .split('\n')
    .filter(l => l.trim() !== '');
  return lines.slice(-n).join('\n');
}

// ---------- quiet shaping for error-only text runners ----------
//
// Keeps error-looking lines plus the trailing summary and drops boot noise.
// If the process died without a result line, the tail still shows the cause.

// The astro warm-up lines every command prints first.
const BOOT_NOISE_RE = /^\d\d:\d\d:\d\d \[(?:types|@astrojs\/node)\]/;

/** tsc (`src/x.ts:12:3: error TS2345`), astro check (`- error`), vite (✖).
 *  `- 0 errors` summaries match too, harmlessly: they're in the kept tail. */
function looksLikeError(line) {
  if (/\b0 errors?\b/i.test(line)) return false;
  return /\berror\b/i.test(line) || line.includes('✖');
}

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

/** Playwright's JSON embeds colour codes even with stdout redirected. */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
export function stripAnsi(text) {
  return String(text ?? '').replaceAll(ANSI_RE, '');
}

// ---------- ESLint (--format json) ----------

/** Every error in full with its position; warnings as per-file counts.
 *  null when the text isn't an ESLint report. */
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

/** Reads the report file (stdout carries the web server's stderr). Failures
 *  are any non-pass: unexpected, flaky (passed on retry), interrupted,
 *  didNotRun. Root-level errors (globalSetup, web server) go in
 *  globalErrors[]. null when the text isn't a report. */
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

// ---------- unit runner's machine line ----------
//
// quiet-reporter.mjs ends stdout with one JSON line prefixed @@devmcp.

export const MACHINE_LINE_PREFIX = '@@devmcp ';

/** null if the reporter is missing or mangled; the caller falls back to raw text. */
export function extractUnitSummary(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith(MACHINE_LINE_PREFIX)) continue;
    try {
      const parsed = JSON.parse(lines[i].slice(MACHINE_LINE_PREFIX.length));
      if (parsed !== null && typeof parsed === 'object' && parsed.counts) return parsed;
    } catch {
      // keep looking: an earlier stale or partial line isn't the answer
    }
  }
  return null;
}

export function stripMachineLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter(l => !l.startsWith(MACHINE_LINE_PREFIX))
    .join('\n');
}
