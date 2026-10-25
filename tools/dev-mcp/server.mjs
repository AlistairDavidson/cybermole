#!/usr/bin/env node
// server.mjs — the cybermole-dev MCP server (docs/plans/dev-test-mcp-plan.md):
// the repo's validation ladder (AGENTS.md, Testing) as six stdio MCP tools
// that answer in ONE structured envelope, so an agent's context fills with
// failure detail only, not per-test reporting. The npm scripts stay the
// substrate; these tools are the quiet orchestration + output-shaping layer
// on top (barbarus's project-MCP design, parsed-not-pattern-matched where
// the runners emit machine formats — plan §1).
//
// Deliberately NOT server/mcp.ts's kind of server: that one is the shipped
// appliance's jobs proxy, results verbatim; this one runs only in dev
// checkouts, never ships (package.json `files` excludes tools/), and is a
// subprocess orchestrator. Plain .mjs, no build step — it must run from any
// checkout or fleet worktree pre-build.
//
// The repo root is resolved from import.meta.url (…/tools/dev-mcp → ../..)
// and every child process runs with THAT as cwd — the launcher's cwd never
// matters. stdout is the MCP protocol channel: nothing here logs to it.
//
// Registered by .pi/mcp.json as `cybermole-dev` (direct exposure):
//   run_check, run_lint, run_format_check, run_build,
//   run_unit_tests, run_e2e — one per npm script, plan §2/§3.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  anchorQuiet,
  extractUnitSummary,
  parseEslintJson,
  parsePlaywrightJson,
  stripAnsi,
  stripMachineLines,
  tailLines,
  trimOutput,
} from './parsers.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BIN = name => path.join(REPO_ROOT, 'node_modules', '.bin', name);
const QUIET_REPORTER = path.join(REPO_ROOT, 'tools', 'dev-mcp', 'quiet-reporter.mjs');

// ---------- the child-process runner (plan §1.7: timeout per tool, kill) ----------

/** The live detached children, so this server dying never orphans a run:
 *  pi stops stdio servers by killing the server's process GROUP, but the
 *  children below run in groups of their own (detached, so timeout kills
 *  reach their grandchildren) — and some grandchildren detach AGAIN
 *  (playwright's web servers), so a group kill alone never reaches them.
 *  Killing is therefore tree-shaped: the child's group, plus every
 *  /proc-descendant that slipped into a group of its own. */
const liveChildren = new Set();

/** Every process below root, by walking /proc's ppid links (Linux only —
 *  elsewhere the answer is empty and the group kill carries the day). */
function descendantPids(root) {
  if (process.platform !== 'linux') return [];
  const childrenOf = new Map();
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const after = stat.slice(stat.lastIndexOf(')') + 2);
        const ppid = Number(after.split(' ')[1]);
        if (Number.isFinite(ppid)) {
          if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
          childrenOf.get(ppid).push(Number(entry));
        }
      } catch {
        /* raced away — fine */
      }
    }
  } catch {
    return [];
  }
  const out = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const c of childrenOf.get(queue.shift()) ?? []) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

function killTree(child, signal) {
  if (child.pid === undefined) return;
  const descendants = descendantPids(child.pid); // BEFORE the group kill: playwright dying reparents them out of reach
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** TERMinate now, SIGKILL the survivors after a grace beat, and let the
 *  process live long enough for that second pass (an unref'd timer after
 *  process.exit never fires — learned live). */
function nuke(child) {
  killTree(child, 'SIGTERM');
  setTimeout(() => killTree(child, 'SIGKILL'), 2000);
}

process.on('exit', () => {
  for (const child of liveChildren) killTree(child, 'SIGTERM');
});
// pi stops stdio servers with stdin-close then SIGTERM then SIGKILL — and a
// SIGTERM kills this process WITHOUT running exit hooks, so the runs must
// be taken along here, explicitly, with room for the SIGKILL pass
const dieWithChildren = () => {
  for (const child of liveChildren) nuke(child);
  setTimeout(() => process.exit(0), 2500);
};
process.on('SIGTERM', dieWithChildren);
process.on('SIGINT', dieWithChildren);

/** One subprocess: command + args, cwd REPO_ROOT, stdout/stderr captured
 *  separately (1 MiB per stream — far over anything the parsers need), a
 *  per-call timeout that kills the whole process GROUP (detached spawn, so
 *  grandchildren — the playwright web servers, node:test's per-file
 *  children — die with it: SIGTERM, then SIGKILL after a grace beat), and
 *  the request's abort signal treated the same — a cancelled call kills
 *  its run instead of leaking it (learned live: an abandoned e2e run
 *  holds the suite's ports). The child env is the parent's minus
 *  NODE_TEST_CONTEXT — a stray marker (the server spawned from inside a
 *  node:test child) makes node:test runners refuse to run files. A spawn
 *  failure (ENOENT &c.) resolves like a 127 exit with the reason in
 *  stderr — it is a tool answer, not an exception. */
function runChild(cmd, args, { timeoutMs, env, cwd = REPO_ROOT, signal } = {}) {
  const spawnEnv = { ...(env ?? process.env) };
  delete spawnEnv.NODE_TEST_CONTEXT; // a stray marker makes node:test runners refuse to run files
  return new Promise(resolve => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolve({
        code: 127,
        stdout: '',
        stderr: `failed to spawn ${cmd}: ${err?.message ?? err}`,
        timedOut: false,
        duration_s: 0,
      });
      return;
    }
    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const CAP = 1024 * 1024;
    child.stdout.on('data', c => {
      if (stdout.length < CAP) stdout += c;
    });
    child.stderr.on('data', c => {
      if (stderr.length < CAP) stderr += c;
    });
    const killGroup = () => nuke(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const onAbort = () => killGroup();
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      liveChildren.delete(child);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        duration_s: Math.round((Date.now() - startedAt) / 100) / 10,
      });
    };
    child.on('error', err => {
      stderr += `\n${err?.message ?? err}`;
      settle(127);
    });
    child.on('close', code => settle(code));
  });
}

/** A `&&` pipeline over a shared deadline: labeled steps run in order, the
 *  first nonzero (or timed-out) step ends the run. Returns every step's
 *  result plus the aggregate ({code, timedOut} of the failing/last step,
 *  duration summed) — the tools compose per-step text from steps[]. */
async function runPipeline(steps, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  const results = [];
  let totalMs = 0;
  for (const step of steps) {
    const remaining = deadline - Date.now();
    let r;
    if (remaining <= 0) {
      r = {
        code: 124,
        stdout: '',
        stderr: 'timeout: the tool deadline expired before this step started',
        timedOut: true,
        duration_s: 0,
      };
    } else {
      r = await runChild(step.cmd, step.args, { timeoutMs: remaining, env: step.env, signal });
    }
    totalMs += r.duration_s * 1000;
    results.push({ label: step.label, r });
    if (r.code !== 0) break;
  }
  const last = results[results.length - 1].r;
  return {
    code: last.code,
    timedOut: last.timedOut,
    duration_s: Math.round(totalMs / 100) / 10,
    steps: results,
    failed: last.code !== 0,
  };
}

// ---------- the shared envelope (plan §5) ----------

function envelope({
  passed,
  returncode,
  duration_s,
  quiet,
  timed_out = false,
  output,
  counts,
  failures,
}) {
  const e = {
    passed: passed === true,
    returncode,
    duration_s,
    quiet,
    timed_out,
    output: trimOutput(stripAnsi(String(output ?? ''))),
  };
  if (counts !== undefined) e.counts = counts;
  if (failures !== undefined) e.failures = failures;
  return e;
}

/** A step's quiet text: anchor-shaped stdout (errors + result tail, boot
 *  noise dropped); a failing step also carries its stderr tail — the crash
 *  reason, the part of stderr that is information. */
function stepText(label, r, { clean = 'clean' } = {}) {
  const ok = r.code === 0 && !r.timedOut;
  const body = anchorQuiet(r.stdout).trim();
  const parts = [`## ${label}${ok ? '' : ` (exit ${r.code}${r.timedOut ? ', timed out' : ''})`}`];
  parts.push(ok && body === '' ? clean : body === '' ? '(no output)' : body);
  if (!ok && r.stderr.trim() !== '') parts.push('--- stderr tail ---', tailLines(r.stderr, 20));
  return parts.join('\n');
}

const result = e => ({ content: [{ type: 'text', text: JSON.stringify(e, null, 2) }] });
const badRequest = why => ({ content: [{ type: 'text', text: why }], isError: true });

/** A heartbeat for long runs: notifications/progress every 30 s with the
 *  elapsed seconds, sent ONLY when the client sent a progressToken (the
 *  spec's rule) — clients that honor progress (pi resets its per-request
 *  timeout on one) stay alive through multi-minute runs. No token, no
 *  notifications; the registration's own `timeout` is the belt to this
 *  braces. Returns the stop function. */
function heartbeat(extra, phase) {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return () => {};
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: elapsed, message: `${phase} — ${elapsed}s` },
      })
      .catch(() => {});
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Run one long await under the heartbeat, handing the request's abort
 *  signal to the run (a cancelled call kills its child tree). */
async function beat(extra, phase, fn) {
  const stop = heartbeat(extra, phase);
  try {
    return await fn(extra?.signal);
  } finally {
    stop();
  }
}

/** Shared params on every tool (plan §3): quiet defaults true (success is
 *  one glance — flag + counts; verbose only when debugging the reporting
 *  itself), timeout per tool with kill on expiry. Handlers read them with
 *  nullish guards so a client that omits them gets the defaults regardless
 *  of schema-default plumbing. */
const quietParam = z
  .boolean()
  .default(true)
  .describe(
    'quiet (default): parsed counts/failures and a short summary — context fills with failure detail only. false = the runner output verbatim (for debugging the reporting itself)',
  );
const timeoutParam = def =>
  z
    .number()
    .int()
    .min(1)
    .max(7200)
    .default(def)
    .describe(`timeout in seconds — the whole process group is killed on expiry; default ${def}`);

/** Repo-relative unit test files for a `file` arg: the stem (ids →
 *  tests/unit/ids.test.mjs) or a path; null when nothing matches. No arg =
 *  every tests/unit/*.test.mjs, sorted (the npm glob's order). */
function unitFiles(file) {
  const unitDir = path.join(REPO_ROOT, 'tests', 'unit');
  if (file === undefined) {
    return readdirSync(unitDir)
      .filter(f => f.endsWith('.test.mjs'))
      .sort()
      .map(f => path.join('tests', 'unit', f));
  }
  const candidates = [
    file,
    `${file}.test.mjs`,
    path.join('tests', 'unit', file),
    path.join('tests', 'unit', `${file}.test.mjs`),
  ];
  for (const c of candidates) if (existsSync(path.join(REPO_ROOT, c))) return [c];
  return null;
}

/** Spec paths for an e2e `file` arg: stem (terminal-ws →
 *  tests/e2e/terminal-ws.spec.ts) or a repo-relative path; null when nothing
 *  matches. */
function e2eFile(file) {
  const candidates = [
    file,
    `${file}.spec.ts`,
    path.join('tests', 'e2e', file),
    path.join('tests', 'e2e', `${file}.spec.ts`),
  ];
  for (const c of candidates) if (existsSync(path.join(REPO_ROOT, c))) return [c];
  return null;
}

// ---------- the server ----------

const server = new McpServer({ name: 'cybermole-dev', version: '0.1.0' });

const LADDER_DOC =
  'The result is one JSON envelope: {passed, returncode, duration_s, quiet, timed_out, output, counts?, failures?} — read passed first; output matters only on failure. The same envelope shape across all six tools.';

server.registerTool(
  'run_check',
  {
    description:
      'The type-check gate (npm run check): astro check over the .astro files/src/components/tests, then a no-emit tsc of the server build — astro build does not type-check, so this gates every review. ' +
      LADDER_DOC,
    inputSchema: { quiet: quietParam, timeout: timeoutParam(600) },
  },
  async ({ quiet, timeout }, extra) => {
    const q = quiet !== false;
    const t = timeout ?? 600;
    const p = await beat(extra, 'astro check + tsc', signal =>
      runPipeline(
        [
          { label: 'astro check', cmd: BIN('astro'), args: ['check'] },
          {
            label: 'tsc -p tsconfig.server.json --noEmit',
            cmd: BIN('tsc'),
            args: ['-p', 'tsconfig.server.json', '--noEmit'],
          },
        ],
        t * 1000,
        signal,
      ),
    );
    const text = p.steps.map(({ label, r }) => stepText(label, r)).join('\n\n');
    return result(
      envelope({
        passed: !p.failed && !p.timedOut,
        returncode: p.code,
        duration_s: p.duration_s,
        quiet: q,
        timed_out: p.timedOut,
        output: q
          ? text
          : p.steps
              .map(({ label, r }) => `## ${label}\n${r.stdout}\n--- stderr ---\n${r.stderr}`)
              .join('\n\n'),
      }),
    );
  },
);

server.registerTool(
  'run_lint',
  {
    description:
      'ESLint 9 flat config over the repo (npm run lint; fix=true is npm run lint:fix — the report parsed is the post-fix pass). counts: {files, errors, warnings, fixable}; failures[] carries every error in full (file + line:col + rule), warnings stay per-file counts. ' +
      LADDER_DOC,
    inputSchema: {
      fix: z.boolean().default(false).describe('apply --fix first, then report what remains'),
      quiet: quietParam,
      timeout: timeoutParam(300),
    },
  },
  async ({ fix, quiet, timeout }, extra) => {
    const q = quiet !== false;
    const args = ['.', '--format', 'json'];
    if (fix === true) args.push('--fix');
    const r = await beat(extra, `eslint .${fix === true ? ' --fix' : ''}`, signal =>
      runChild(BIN('eslint'), args, { timeoutMs: (timeout ?? 300) * 1000, signal }),
    );
    const parsed = q ? parseEslintJson(r.stdout, REPO_ROOT) : null;
    let output;
    let counts;
    let failures;
    let passed = r.code === 0 && !r.timedOut;
    if (parsed !== null) {
      counts = parsed.counts;
      failures = parsed.failures;
      passed = passed && counts.errors === 0;
      const parts = [
        `lint${fix === true ? ' --fix' : ''}: ${counts.errors} error${counts.errors === 1 ? '' : 's'}, ` +
          `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'} (${counts.files} files` +
          `${counts.fixable > 0 ? `, ${counts.fixable} fixable` : ''})`,
      ];
      for (const f of failures) parts.push(`${f.name}\n    ${f.error}`);
      for (const w of parsed.warningsByFile) parts.push(`warn  ${w}`);
      output = parts.join('\n');
    } else {
      // unparseable (or verbose): the raw text is the answer
      output = `${r.stdout}\n${r.stderr}`.trim() || '(no output)';
    }
    if (!passed && r.stderr.trim() !== '')
      output += `\n--- stderr tail ---\n${tailLines(r.stderr, 20)}`;
    return result(
      envelope({
        passed,
        returncode: r.code,
        duration_s: r.duration_s,
        quiet: q,
        timed_out: r.timedOut,
        output,
        ...(counts !== undefined ? { counts } : {}),
        ...(failures !== undefined ? { failures } : {}),
      }),
    );
  },
);

server.registerTool(
  'run_format_check',
  {
    description:
      'Prettier --check over the repo (npm run format:check). Its whole output IS the offending-file list, so quiet mode keeps it as-is. ' +
      LADDER_DOC,
    inputSchema: { quiet: quietParam, timeout: timeoutParam(600) },
  },
  async ({ quiet, timeout }, extra) => {
    const q = quiet !== false;
    const r = await beat(extra, 'prettier --check .', signal =>
      runChild(BIN('prettier'), ['--check', '.'], {
        timeoutMs: (timeout ?? 600) * 1000,
        signal,
      }),
    );
    const text = `${r.stdout.trim()}${r.stderr.trim() !== '' ? `\n${r.stderr.trim()}` : ''}`;
    return result(
      envelope({
        passed: r.code === 0 && !r.timedOut,
        returncode: r.code,
        duration_s: r.duration_s,
        quiet: q,
        timed_out: r.timedOut,
        output: text === '' ? 'clean — all matched files use Prettier code style' : text,
      }),
    );
  },
);

server.registerTool(
  'run_build',
  {
    description:
      'The build (npm run build): astro build then the server tsc — required before test:unit/test:e2e. server_only=true is just the tsc half (enough to refresh dist-server for the unit tests). ' +
      LADDER_DOC,
    inputSchema: {
      server_only: z
        .boolean()
        .default(false)
        .describe('skip astro build — only compile dist-server (the test:unit build half)'),
      quiet: quietParam,
      timeout: timeoutParam(900),
    },
  },
  async ({ server_only, quiet, timeout }, extra) => {
    const q = quiet !== false;
    const p = await beat(
      extra,
      server_only === true ? 'tsc (server)' : 'astro build + tsc',
      signal =>
        runPipeline(
          server_only === true
            ? [
                {
                  label: 'tsc -p tsconfig.server.json',
                  cmd: BIN('tsc'),
                  args: ['-p', 'tsconfig.server.json'],
                },
              ]
            : [
                { label: 'astro build', cmd: BIN('astro'), args: ['build'] },
                {
                  label: 'tsc -p tsconfig.server.json',
                  cmd: BIN('tsc'),
                  args: ['-p', 'tsconfig.server.json'],
                },
              ],
          (timeout ?? 900) * 1000,
          signal,
        ),
    );
    const text = p.steps.map(({ label, r }) => stepText(label, r)).join('\n\n');
    return result(
      envelope({
        passed: !p.failed && !p.timedOut,
        returncode: p.code,
        duration_s: p.duration_s,
        quiet: q,
        timed_out: p.timedOut,
        output: q
          ? text
          : p.steps
              .map(({ label, r }) => `## ${label}\n${r.stdout}\n--- stderr ---\n${r.stderr}`)
              .join('\n\n'),
      }),
    );
  },
);

server.registerTool(
  'run_unit_tests',
  {
    description:
      'node:test units in tests/unit/ against the compiled dist-server (npm run test:unit — compiles first; skip_build=true reuses the existing dist-server). Quiet mode runs through the quiet reporter: counts {pass, fail, skipped, todo, cancelled} + failures[] with name/file/error/duration per failure; a passing run is a handful of lines. file matches a test-file stem (ids → tests/unit/ids.test.mjs), name is a --test-name-pattern (requires file) — targeted before full, exactly the ladder rule. ' +
      LADDER_DOC,
    inputSchema: {
      file: z
        .string()
        .optional()
        .describe(
          'one unit test file: stem (jobs) or path (tests/unit/jobs.test.mjs); absent = the whole suite',
        ),
      name: z
        .string()
        .optional()
        .describe('a --test-name-pattern, running only matching tests (requires file)'),
      skip_build: z
        .boolean()
        .default(false)
        .describe('reuse the existing dist-server (no tsc first)'),
      quiet: quietParam,
      timeout: timeoutParam(1800),
    },
  },
  async ({ file, name, skip_build, quiet, timeout }, extra) => {
    const q = quiet !== false;
    const t = timeout ?? 1800;
    if (name !== undefined && file === undefined) {
      return badRequest(
        'name needs file — a --test-name-pattern only narrows a chosen test file (pass file too)',
      );
    }
    const files = unitFiles(file);
    if (files === null) {
      return badRequest(
        `no unit test file matches ${JSON.stringify(file)} — pass a stem like "ids" or a path like tests/unit/ids.test.mjs`,
      );
    }
    const absolute = files.map(f => path.join(REPO_ROOT, f));

    // Verbose: the plain `node --test` run with the spec reporter — the
    // full per-test reporting, for debugging the reporting itself.
    if (!q) {
      const steps = [];
      if (skip_build !== true) {
        steps.push({
          label: 'tsc -p tsconfig.server.json',
          cmd: BIN('tsc'),
          args: ['-p', 'tsconfig.server.json'],
        });
      }
      const testArgs = ['--test', '--test-reporter=spec', ...absolute];
      if (name !== undefined) testArgs.push('--test-name-pattern', name);
      steps.push({ label: 'node --test', cmd: process.execPath, args: testArgs });
      const p = await beat(extra, 'node --test (verbose)', signal =>
        runPipeline(steps, t * 1000, signal),
      );
      return result(
        envelope({
          passed: !p.failed && !p.timedOut,
          returncode: p.code,
          duration_s: p.duration_s,
          quiet: false,
          timed_out: p.timedOut,
          output: p.steps
            .map(({ label, r }) => `## ${label}\n${r.stdout}\n--- stderr ---\n${r.stderr}`)
            .join('\n\n'),
        }),
      );
    }

    // Quiet: tsc (unless skipped) then the quiet reporter.
    const steps = [];
    if (skip_build !== true) {
      steps.push({
        label: 'tsc -p tsconfig.server.json',
        cmd: BIN('tsc'),
        args: ['-p', 'tsconfig.server.json'],
      });
    }
    const reporterArgs = [QUIET_REPORTER, ...absolute];
    if (name !== undefined) reporterArgs.push('--name-pattern', name);
    steps.push({ label: 'unit tests', cmd: process.execPath, args: reporterArgs });
    const p = await beat(extra, 'unit tests', signal => runPipeline(steps, t * 1000, signal));

    const runStep = p.steps.find(s => s.label === 'unit tests');
    const summary = runStep === undefined ? null : extractUnitSummary(runStep.r.stdout);
    let output;
    let counts;
    let failures;
    if (summary !== null) {
      counts = summary.counts;
      failures = summary.failures;
      const scope = files.length === 1 ? files[0] : `${files.length} files`;
      output =
        `${scope}: pass ${counts.pass}, fail ${counts.fail}` +
        `, skipped ${counts.skipped}, todo ${counts.todo}, cancelled ${counts.cancelled}` +
        `\n${stripMachineLines(runStep.r.stdout).trim()}`;
    } else {
      // no machine summary: a step failed before the reporter ran (the tsc
      // build), or the run collapsed — the collected text is the answer
      output =
        p.steps.map(({ label, r }) => stepText(label, r, { clean: 'clean' })).join('\n\n') ||
        '(no output)';
    }
    const passed = !p.failed && !p.timedOut;
    if (!passed && p.steps[p.steps.length - 1].r.stderr.trim() !== '') {
      output += `\n--- stderr tail ---\n${tailLines(p.steps[p.steps.length - 1].r.stderr, 20)}`;
    }
    return result(
      envelope({
        passed,
        returncode: p.code,
        duration_s: p.duration_s,
        quiet: q,
        timed_out: p.timedOut,
        output,
        ...(counts !== undefined ? { counts } : {}),
        ...(failures !== undefined ? { failures } : {}),
      }),
    );
  },
);

server.registerTool(
  'run_e2e',
  {
    description:
      'The Playwright integration suite (npm run test:e2e) — chromium, hermetic workspace at /tmp/cybermole-itest, boots its own server from dist-server (run_build first on a cold checkout, or the suite global-setup builds when dist/ is missing). Host runs are serial — one /tmp/cybermole-itest at a time; fleet sandboxes are unaffected (per-container /tmp). grep is Playwright --grep over titles; file takes a spec stem or path (terminal-ws → tests/e2e/terminal-ws.spec.ts) — targeted before full. counts {pass, fail, flaky, skipped, interrupted, didNotRun} + failures[] with title, file:line and the trimmed error; on infra collapse (server never boots) there are no counts — passed: false with the web-server stderr tail. ' +
      LADDER_DOC,
    inputSchema: {
      grep: z.string().optional().describe("Playwright's --grep pattern over test titles"),
      file: z.string().optional().describe('one spec: stem (e2e) or path (tests/e2e/e2e.spec.ts)'),
      quiet: quietParam,
      timeout: timeoutParam(3600),
    },
  },
  async ({ grep, file, quiet, timeout }, extra) => {
    const q = quiet !== false;
    const specArgs = [];
    if (file !== undefined) {
      const f = e2eFile(file);
      if (f === null) {
        return badRequest(
          `no spec matches ${JSON.stringify(file)} — pass a stem like "terminal-ws" or a path like tests/e2e/terminal-ws.spec.ts`,
        );
      }
      specArgs.push(...f.map(p => path.join(REPO_ROOT, p)));
    }
    if (grep !== undefined) specArgs.push('--grep', grep);

    const reportDir = mkdtempSync(path.join(os.tmpdir(), 'cybermole-dev-e2e-'));
    const reportPath = path.join(reportDir, 'report.json');
    try {
      // JSON to a temp file — stdout stays the list reporter's channel and
      // the web-server's stderr rides stderr, each captured separately
      const r = await beat(extra, 'playwright e2e', signal =>
        runChild(BIN('playwright'), ['test', '--reporter=json', ...specArgs], {
          timeoutMs: (timeout ?? 3600) * 1000,
          env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
          signal,
        }),
      );
      const parsed =
        q && existsSync(reportPath)
          ? parsePlaywrightJson(readFileSync(reportPath, 'utf8'), REPO_ROOT)
          : null;
      let output;
      let counts;
      let failures;
      if (parsed !== null) {
        counts = parsed.counts;
        failures = parsed.failures;
        const secs = Math.round(r.duration_s);
        const c = counts;
        output =
          `e2e: ${c.pass} passed, ${c.fail} failed` +
          `${c.flaky > 0 ? `, ${c.flaky} flaky` : ''}` +
          `${c.skipped > 0 ? `, ${c.skipped} skipped` : ''}` +
          `${c.interrupted > 0 ? `, ${c.interrupted} interrupted` : ''}` +
          `${c.didNotRun > 0 ? `, ${c.didNotRun} did not run` : ''}` +
          ` (${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s)`;
        for (const f of failures) {
          output += `\n✖ ${f.name}${f.file !== '' ? ` (${f.file})` : ''}\n    ${f.error.split('\n').join('\n    ')}`;
        }
        for (const ge of parsed.globalErrors)
          output += `\nglobal error: ${ge.split('\n').join('\n    ')}`;
      } else if (q) {
        // no report file (infra collapse, kill mid-run, parse miss): the
        // raw text is the answer — anchor-miss fallback, another shape
        output = `${r.stdout}\n${r.stderr}`.trim() || '(no output)';
      } else {
        output = `${r.stdout}\n--- stderr ---\n${r.stderr}`;
      }
      if (r.code !== 0 && r.stderr.trim() !== '') {
        output += `\n--- stderr tail ---\n${tailLines(r.stderr, 30)}`;
      }
      return result(
        envelope({
          passed: r.code === 0 && !r.timedOut,
          returncode: r.code,
          duration_s: r.duration_s,
          quiet: q,
          timed_out: r.timedOut,
          output: output === '' ? '(no output)' : output,
          ...(counts !== undefined ? { counts } : {}),
          ...(failures !== undefined ? { failures } : {}),
        }),
      );
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  },
);

// ---------- the entry ----------

await server.connect(new StdioServerTransport());
