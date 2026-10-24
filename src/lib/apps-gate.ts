// apps-gate.ts — the check/build half of the cybermole-apps MCP
// (task/app-scaffold, docs/apps-plan.md §6): run an app tree's OWN
// package.json scripts (the template bakes them; the tree owns the
// commands) and answer ONE quiet envelope — the cybermole-dev tools'
// contract ({passed, returncode, duration_s, quiet, timed_out, output,
// counts?, failures?} — read passed first, counts on a glance, failure
// detail in failures[]/output). check = astro check + tsc (the tree's
// typecheck script) + the tree's unit tests + astro build (with the
// route-table emission and the §5 self-containment gate, both inside the
// build script) — THE gate before any report of done. build = check's
// astro-build half alone.
//
// Stage 0 is the LINKS check (plan §5): every dependency the tree
// declares must resolve in its node_modules — the per-package symlinks
// intact. A bad install dies HERE, with the fix in the message, not
// three stages later in a compiler error — and never at serve time.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';
import { CommandNotFoundError, type ChildRun, type RunChildFn } from './apps-child';

// ---------- the envelope (tools/dev-mcp's shape) ----------

/** The unit-test counts parsed from the test stage's TAP footer (node
 *  --test reports them; absent when the stage never ran or a crash ate
 *  the footer). */
export interface GateTestCounts {
  pass: number;
  fail: number;
  skipped: number;
}

export interface GateCounts {
  stages: { total: number; passed: number; failed: number };
  tests?: GateTestCounts;
}

export interface GateFailure {
  stage: string;
  error: string;
}

export interface GateEnvelope {
  passed: boolean;
  returncode: number;
  duration_s: number;
  quiet: true;
  timed_out: boolean;
  output: string;
  counts?: GateCounts;
  failures?: GateFailure[];
}

// ---------- the family (the tree-level preconditions) ----------

export type AppGateData = { slug: string; tree: string; envelope: GateEnvelope };
export type AppGateErrorCode = 'tree_not_found' | 'run_failed';
export type AppGateSuccess = ResultSuccess<'app_gate', AppGateData>;
export type AppGateFailure = ResultFailure<'app_gate', AppGateData, AppGateErrorCode>;
export type AppGateResult = AppGateSuccess | AppGateFailure;

export interface GateDeps {
  appsRoot: string;
  /** the child runner (injectable; apps-child.runChild is the real one) */
  run: RunChildFn;
  /** per-stage timeout. Default 300 s — astro build of a real app. */
  timeoutMs?: number;
}

// ---------- stage plumbing ----------

interface StageSpec {
  /** the npm script the tree owns (npm run <name>) */
  script: string;
  /** extra args after `npm run <script> --` (e.g. a machine-readable
   *  test reporter — the REPORTER is the MCP's parsing concern, not a
   *  command change; the script still owns the command). */
  args?: string[];
  /** the stage's name in the envelope */
  label: string;
}

const CHECK_STAGES: StageSpec[] = [
  { script: 'typecheck', label: 'astro check + tsc' },
  { script: 'test', label: 'unit tests', args: ['--test-reporter=tap'] },
  { script: 'build', label: 'astro build + route-table + self-containment' },
];

const BUILD_STAGES: StageSpec[] = [CHECK_STAGES[2]!];

// eslint-disable-next-line no-control-regex -- stripping ANSI color codes is the point
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

function tail(text: string, lines: number): string {
  const stripped = text.replace(ANSI_RE, '');
  const all = stripped.split('\n');
  return all
    .slice(Math.max(0, all.length - lines))
    .join('\n')
    .trim();
}

/** node --test's TAP footer counts (`# pass 3` …), when the run got that
 *  far. TAP is node's stable machine format; the footer is the last word. */
function parseTapCounts(stdout: string): GateTestCounts | undefined {
  const counts: GateTestCounts = { pass: -1, fail: -1, skipped: -1 };
  for (const line of stdout.split('\n')) {
    const m = /^# (pass|fail|skipped) (\d+)$/.exec(line.trim());
    if (m) counts[m[1] as keyof GateTestCounts] = Number(m[2]);
  }
  if (counts.pass < 0 && counts.fail < 0 && counts.skipped < 0) return undefined;
  return {
    pass: Math.max(0, counts.pass),
    fail: Math.max(0, counts.fail),
    skipped: Math.max(0, counts.skipped),
  };
}

/** The links stage: every dependency (and both build bins) the tree
 *  declares resolves inside it. Missing names → the failure, with the
 *  fix in the text; a tree without package.json is not an app tree (the
 *  tree_not_found family answer covers the dir itself). */
function missingLinks(tree: string): string[] {
  const pkgPath = path.join(tree, 'package.json');
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as typeof pkg;
  } catch {
    return ['package.json (unreadable — not an app tree)'];
  }
  const missing: string[] = [];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!fs.existsSync(path.join(tree, 'node_modules', ...name.split('/')))) missing.push(name);
  }
  for (const bin of ['astro', 'tsc']) {
    if (!fs.existsSync(path.join(tree, 'node_modules', '.bin', bin))) missing.push(`.bin/${bin}`);
  }
  return missing;
}

/** Run the stages serially, first failure stops (a failed typecheck
 *  means the build would only re-report it). Pure assembly over the
 *  injectable runner — units drive it with fakes. */
export async function runGate(
  deps: GateDeps,
  slug: string,
  stages: StageSpec[],
): Promise<AppGateResult> {
  const tree = path.join(deps.appsRoot, slug);
  const startedAt = Date.now();
  if (!fs.existsSync(tree)) {
    return {
      ok: false,
      resultType: 'app_gate',
      errorCode: 'tree_not_found',
      errorMessage: `no app tree at ${tree} — scaffold it first (the apps root is ${deps.appsRoot})`,
    } satisfies AppGateFailure;
  }
  const failures: GateFailure[] = [];
  const stageNames = ['links', ...stages.map(s => s.label)];
  const counts: GateCounts = { stages: { total: stageNames.length, passed: 0, failed: 0 } };
  let returncode = 0;
  let timedOut = false;
  let tests: GateTestCounts | undefined;

  const missing = missingLinks(tree);
  if (missing.length > 0) {
    counts.stages.failed = 1;
    failures.push({
      stage: 'links',
      error:
        `node_modules incomplete in the tree: ${missing.join(', ')} missing — ` +
        'run `npm run setup` in the tree to re-link the core stack (install extras with `npm install <pkg>`)',
    });
    returncode = 1;
  } else {
    counts.stages.passed = 1;
    for (const stage of stages) {
      let run: ChildRun;
      try {
        run = await deps.run(
          'npm',
          ['run', stage.script, ...(stage.args ? ['--', ...stage.args] : [])],
          { cwd: tree, timeoutMs: deps.timeoutMs ?? 300_000 },
        );
      } catch (err) {
        const why =
          err instanceof CommandNotFoundError
            ? 'npm is not on PATH'
            : `npm could not run: ${(err as Error).message}`;
        return {
          ok: false,
          resultType: 'app_gate',
          errorCode: 'run_failed',
          errorMessage: `${why} — the tree stands at ${tree}; fix the runner and re-run`,
        } satisfies AppGateFailure;
      }
      if (stage.script === 'test') tests = parseTapCounts(run.stdout);
      if (run.code === 0 && !run.timedOut) {
        counts.stages.passed++;
        continue;
      }
      counts.stages.failed++;
      returncode = run.code ?? 1;
      timedOut = run.timedOut;
      failures.push({
        stage: stage.label,
        error: run.timedOut
          ? `the stage timed out after ${deps.timeoutMs ?? 300_000}ms`
          : tail(
              [run.stdout, run.stderr]
                .map(t => t.trim())
                .filter(Boolean)
                .join('\n'),
              40,
            ),
      });
      break;
    }
  }

  const passed = failures.length === 0;
  const envelope: GateEnvelope = {
    passed,
    returncode: passed ? 0 : returncode,
    duration_s: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    quiet: true,
    timed_out: timedOut,
    output: passed ? `${stageNames.join(' → ')} — all green` : failures[0]!.error,
    counts: tests !== undefined ? { ...counts, tests } : counts,
    ...(failures.length > 0 ? { failures } : {}),
  };
  return {
    ok: true,
    resultType: 'app_gate',
    data: { slug, tree, envelope },
  } satisfies AppGateSuccess;
}

/** check — THE gate (§1's loop): links + typecheck + unit tests + build. */
export function checkApp(deps: GateDeps, slug: string): Promise<AppGateResult> {
  return runGate(deps, slug, CHECK_STAGES);
}

/** build — check's astro-build half alone (route-table emission + the §5
 *  gate ride the tree's build script). */
export function buildApp(deps: GateDeps, slug: string): Promise<AppGateResult> {
  return runGate(deps, slug, BUILD_STAGES);
}
