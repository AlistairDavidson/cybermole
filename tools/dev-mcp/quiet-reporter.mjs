#!/usr/bin/env node
// run_unit_tests' quiet runner over node:test's programmatic run(): reports
// only diagnostics, failures and a final counts line.
//
// A runner rather than a --test-reporter module: module reporters get events
// after structured-clone IPC, which strips Error messages and stacks.
//
// Node 22 quirks handled here:
//  - run({ testNamePattern }) is ignored; it must go in execArgv as
//    --test-name-pattern.
//  - An inherited NODE_TEST_CONTEXT makes run() skip files; drop it.
//  - A file that dies without running tests shows up as a file-level
//    test:fail, or a subtestsFailed complete with no leaf failures; both
//    become crash entries carrying the file's stderr tail.
//
// The last stdout line is `@@devmcp {counts, failures, success}` for
// server.mjs to parse. Exit 0 on success, 1 otherwise.
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

/** node:test wraps the real Error in ERR_TEST_FAILURE; the inner message
 *  and assertion diff are what matter. */
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
    // the file itself failed (import error, early throw): a crash
    crashFiles.add(d.file);
  } else if (ev.type === 'test:fail' && details.type !== 'suite') {
    // a leaf failure (failing suites also emit test:fail; their leaves count individually)
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
    // the file died mid-run with no leaf failures
    crashFiles.add(d.file);
  } else if (ev.type === 'test:stderr' && typeof d.file === 'string') {
    noteStderr(d.file, String(d.message ?? ''));
  } else if (ev.type === 'test:summary' && d.file === undefined) {
    summary = d; // the run's final summary (per-file summaries carry a file)
  }
}

// A suite that never loaded is the loudest failure; its stderr has the error.
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
// The runner's failed count includes a file that died before running
// anything, but not one that died mid-run; max() counts every leaf failure
// and crashed file exactly once.
const leafTotal = [...leafFailsByFile.values()].reduce((a, b) => a + b, 0);
const counts = {
  pass: c.passed ?? 0,
  fail: Math.max(c.failed ?? 0, leafTotal + crashFiles.size),
  skipped: c.skipped ?? 0,
  todo: c.todo ?? 0,
  cancelled: c.cancelled ?? 0,
};
// Prefer the runner's own summary when it emitted one (it saw everything).
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
