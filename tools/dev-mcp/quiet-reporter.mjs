#!/usr/bin/env node
// quiet-reporter.mjs — run_unit_tests' quiet half (docs/dev-test-mcp-plan.md
// §4 "node:test — suppress at the source"). A thin runner over node:test's
// programmatic `run()` that reports ONLY diagnostics, failures (name, error,
// duration) and a final counts line: on a passing run the whole output is a
// handful of lines instead of a line per test.
//
// Why a runner and not a `--test-reporter` module: module reporters receive
// the event stream after node's structured-clone IPC, which strips Error
// messages and stacks entirely (assertion causes survive only as enumerable
// fields) — a quiet reporter that cannot see why a test failed is useless.
// `run()`'s in-process stream carries the real Error objects, so the failure
// text below is the assertion's own message. The child-per-file isolation
// and semantics are `node --test`'s own — the same run `npm run test:unit`
// does, differently reported.
//
// Node 22 quirks this file absorbs (each verified against 22.22):
//  - `run({ testNamePattern })` is silently IGNORED; the pattern must ride
//    execArgv as --test-name-pattern to reach the per-file children.
//  - a stray NODE_TEST_CONTEXT in the environment (inherited when this
//    runner is itself spawned from inside a node:test child — the dev-mcp
//    unit suite does exactly that) makes run() "skip running files". This
//    is an entry-point process, so the marker is always an accident of
//    inheritance: drop it.
//  - a test file that dies without running tests (import error, an
//    uncaught exception) surfaces as an envelope test:fail whose name is
//    the file path, or as a subtestsFailed test:complete with zero leaf
//    failures — both become crash entries, with the file's stderr tail
//    (where the thrown error actually is) as the detail.
//
// The last stdout line is the machine summary — one line of JSON prefixed
// `@@devmcp ` ({counts, failures, success}) that tools/dev-mcp/server.mjs
// parses (parsers.mjs extractUnitSummary) into the envelope's structured
// fields; every line before it is quiet human text. Exit code: 0 on
// success, 1 otherwise (the same contract `node --test` has).
//
// Usage: node quiet-reporter.mjs <test-file...> [--name-pattern <pattern>]
import { run } from 'node:test';
import * as path from 'node:path';
import process from 'node:process';
import { trimOutput } from './parsers.mjs';

delete process.env.NODE_TEST_CONTEXT; // see the quirks note above

const argv = process.argv.slice(2);
const files = [];
let testNamePattern;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--name-pattern') testNamePattern = argv[++i];
  else files.push(argv[i]);
}
if (files.length === 0) {
  console.error('quiet-reporter: no test files given');
  process.exit(2);
}

const failures = [];
const leafFailsByFile = new Map(); // absolute file → leaf test:fail count
const stderrByFile = new Map(); // file → its crashed children's stderr (tail)
const crashFiles = new Set(); // files that died without (only) leaf failures
let summary = null;

const emit = line => process.stdout.write(`${line}\n`);
const ms = v => (typeof v === 'number' ? `${Math.round(v * 10) / 10}ms` : '');

/** A failure's error text: the real Error's message (node:test wraps it in
 *  an ERR_TEST_FAILURE envelope whose code says nothing new — the message
 *  and its assertion diff are the value), trimmed per-failure. */
function errorText(err) {
  if (err === null || err === undefined) return 'unknown error';
  const parts = [err.message ?? String(err)];
  const code = err.code === 'ERR_TEST_FAILURE' ? (err.cause?.code ?? null) : err.code;
  if (typeof code === 'string' && code !== '') parts.push(`(${code})`);
  return trimOutput(parts.join(' '), 2048);
}

const noteStderr = (file, chunk) => {
  const prev = stderrByFile.get(file) ?? '';
  stderrByFile.set(file, (prev + chunk).slice(-4096));
};

const stream = run({
  files: files.map(f => path.resolve(f)),
  ...(testNamePattern === undefined
    ? {}
    : { execArgv: [...process.execArgv, `--test-name-pattern=${testNamePattern}`] }),
});

for await (const ev of stream) {
  const d = ev.data ?? {};
  const details = d.details ?? {};
  if (ev.type === 'test:fail' && d.name === d.file) {
    // the file envelope failing as a test of its own: the file died (an
    // import error, an early throw) — a crash, not a leaf failure
    crashFiles.add(d.file);
  } else if (ev.type === 'test:fail' && details.type !== 'suite') {
    // a leaf test failure (failing describe-suites also emit test:fail,
    // with details.type 'suite' — their leaves are counted individually)
    const file = typeof d.file === 'string' ? `${d.file}:${d.line ?? 0}` : '';
    leafFailsByFile.set(d.file, (leafFailsByFile.get(d.file) ?? 0) + 1);
    const failure = {
      name: d.name ?? '(unnamed test)',
      file,
      error: errorText(details.error),
      ...(typeof details.duration_ms === 'number' ? { duration_ms: details.duration_ms } : {}),
    };
    failures.push(failure);
    emit(`✖ ${failure.name} (${failure.file}) ${ms(failure.duration_ms)}`);
    for (const line of failure.error.split('\n')) emit(`    ${line}`);
  } else if (
    ev.type === 'test:complete' &&
    details.passed === false &&
    details.error?.failureType === 'subtestsFailed' &&
    (leafFailsByFile.get(d.file) ?? 0) === 0
  ) {
    // the file envelope reporting subtest failure with NO leaf failures:
    // the file died mid-run (after starting, before/around its tests)
    crashFiles.add(d.file);
  } else if (ev.type === 'test:stderr' && typeof d.file === 'string') {
    noteStderr(d.file, String(d.message ?? ''));
  } else if (ev.type === 'test:summary' && d.file === undefined) {
    summary = d; // the run's final summary (per-file summaries carry a file)
  }
}

// File crashes become failure entries too — a suite that never loaded is
// the loudest failure there is; its stderr tail is where the error lives.
for (const file of crashFiles) {
  const error = trimOutput(
    (stderrByFile.get(file) ?? '').trim() || `test file failed without running any test (${file})`,
    2048,
  );
  failures.push({ name: path.basename(file), file, error });
  emit(`✖ ${path.basename(file)} — test file crashed (${file})`);
  for (const line of error.split('\n')) emit(`    ${line}`);
}

const c = summary?.counts ?? {};
// The summary's failed count includes the file envelope when a file died
// before running anything (an import error), but NOT a mid-run file death
// (only its leaf failures) — max() of the two spellings is the honest
// total: every leaf failure plus every crashed file, never double-counted.
const leafTotal = [...leafFailsByFile.values()].reduce((a, b) => a + b, 0);
const counts = {
  pass: c.passed ?? 0,
  fail: Math.max(c.failed ?? 0, leafTotal + crashFiles.size),
  skipped: c.skipped ?? 0,
  todo: c.todo ?? 0,
  cancelled: c.cancelled ?? 0,
};
// success from the runner's own summary when it emitted one (it saw
// everything, including outcomes this reporter filters); otherwise the
// conservative read of what we collected.
const success = summary ? summary.success === true : failures.length === 0;

emit(
  `# tests ${c.tests ?? '?'}` +
    ` | pass ${counts.pass}` +
    ` | fail ${counts.fail}` +
    ` | skipped ${counts.skipped}` +
    ` | todo ${counts.todo}` +
    ` | cancelled ${counts.cancelled}` +
    (typeof summary?.duration_ms === 'number' ? ` | ${Math.round(summary.duration_ms)}ms` : ''),
);
emit(
  `@@devmcp ${JSON.stringify({
    counts,
    ...(failures.length > 0 ? { failures } : {}),
    success,
  })}`,
);
process.exitCode = success ? 0 : 1;
