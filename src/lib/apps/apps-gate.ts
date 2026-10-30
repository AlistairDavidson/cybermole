// check/build for an app tree: runs the tree's own npm scripts and answers
// one quiet envelope (the cybermole-dev tools' shape). check = links +
// typecheck + architecture lint + unit tests + build; build is the last
// stage alone. A stage whose npm script the tree doesn't have is skipped
// (a pre-standard tree keeps passing; the note says what was skipped) —
// EXCEPT lint:arch: a tree with a component layer (src/components or
// src/store) gets the kit's arch-check run host-side whether it declares
// the script or not, so deleting the script line can't silence the gate.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';
import { CommandNotFoundError, type ChildRun, type RunChildFn } from './apps-child';

// ---------- envelope ----------

/** From the TAP footer; absent if the stage never ran or crashed. */
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

export type AppGateData = { slug: string; tree: string; envelope: GateEnvelope };
export type AppGateErrorCode = 'tree_not_found' | 'run_failed';
export type AppGateSuccess = ResultSuccess<'app_gate', AppGateData>;
export type AppGateFailure = ResultFailure<'app_gate', AppGateData, AppGateErrorCode>;
export type AppGateResult = AppGateSuccess | AppGateFailure;

export interface GateDeps {
  appsRoot: string;
  /** the install root (the kit's arch-check lives under it) */
  installRoot: string;
  /** The console's normalized URL base (readBase() shape: '/' at the site
   *  root). The build's baked base is derived from it, so every gate run
   *  re-normalizes the app's astro config first — a base change needs no
   *  hand edits. Default '/': the site root. */
  base?: string;
  run: RunChildFn;
  /** Per stage. Default 300 s (astro build of a real app). */
  timeoutMs?: number;
}

interface StageSpec {
  /** npm run <script> */
  script: string;
  /** extra args after `--` (e.g. a TAP reporter for parsing) */
  args?: string[];
  label: string;
  /** run the kit's arch-check directly (a tree that deleted its script) */
  hostArch?: boolean;
}

const CHECK_STAGES: StageSpec[] = [
  { script: 'typecheck', label: 'astro check + tsc' },
  { script: 'lint:arch', label: 'architecture lint' },
  { script: 'test', label: 'unit tests', args: ['--test-reporter=tap'] },
  { script: 'build', label: 'astro build + route-table + self-containment' },
];

const BUILD_STAGES: StageSpec[] = [CHECK_STAGES[3]!];

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

/** The tree's npm script names, for the skip rule below. */
function treeScripts(tree: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

/** The app's reachability invariant: astro.config.mjs bakes `const base =
 *  '<console base>/apps/<slug>'`. The scaffold writes it; a console base
 *  change (or an app predating based consoles) leaves it stale, which is
 *  exactly what makes an app unreachable at its console URL. Every gate
 *  run re-bakes the line before building, so a rebuild is the only repair
 *  a base change ever needs. A config without the line (heavily customized)
 *  is left alone — the app host's mount check reports the mismatch. */
const APP_BASE_LINE_RE = /^(const base = ')([^']*)(';.*)$/m;

/** The baked base line in an app's astro.config.mjs, when present (null: a
 *  customized config — the app host can't judge it, and mounts it). */
export function readAppConfigBase(tree: string): string | null {
  let source: string;
  try {
    source = fs.readFileSync(path.join(tree, 'astro.config.mjs'), 'utf8');
  } catch {
    return null;
  }
  const match = APP_BASE_LINE_RE.exec(source);
  return match === null ? null : (match[2] ?? null);
}

export function normalizeAppBase(
  tree: string,
  slug: string,
  base = '/',
): {
  changed: boolean;
  /** null: no scaffolded base line found (a customized config, untouched). */
  from: string | null;
  to: string;
} {
  const expected = `${(base ?? '/') === '/' ? '' : base}/apps/${slug}`;
  const file = path.join(tree, 'astro.config.mjs');
  const from = readAppConfigBase(tree);
  if (from === null || from === expected) return { changed: false, from, to: expected };
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, source.replace(APP_BASE_LINE_RE, `$1${expected}$3`));
  return { changed: true, from, to: expected };
}

/** Declared dependencies and the astro/tsc bins that don't resolve in the tree. */
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

/** Serial; the first failure stops the rest. */
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
  normalizeAppBase(tree, slug, deps.base);
  const failures: GateFailure[] = [];
  // Stages whose npm script the tree doesn't have never run — a pre-standard
  // tree keeps passing, the skipped scripts named in the output — except
  // lint:arch under a component layer, which the gate runs itself: the
  // architecture rules are not opt-out (the standard is imposed, not offered).
  const scripts = treeScripts(tree);
  const hasComponentLayer =
    fs.existsSync(path.join(tree, 'src', 'components')) ||
    fs.existsSync(path.join(tree, 'src', 'store'));
  const skipped = stages
    .filter(s => !scripts.has(s.script) && !(s.script === 'lint:arch' && hasComponentLayer))
    .map(s => s.script);
  const active = stages
    .map(s =>
      s.script === 'lint:arch' && !scripts.has('lint:arch') && hasComponentLayer
        ? { ...s, hostArch: true, label: 'architecture lint (host-run)' }
        : s,
    )
    .filter(s => scripts.has(s.script) || s.hostArch === true);
  const stageNames = ['links', ...active.map(s => s.label)];
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
    for (const stage of active) {
      let run: ChildRun;
      try {
        run =
          stage.hostArch === true
            ? await deps.run(
                'node',
                [
                  path.join(deps.installRoot, 'packages', 'app-kit', 'scripts', 'arch-check.mjs'),
                  'src',
                  'astro.config.mjs',
                ],
                { cwd: tree, timeoutMs: deps.timeoutMs ?? 300_000 },
              )
            : await deps.run(
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
    output: passed
      ? `${stageNames.join(' → ')} — all green${
          skipped.length > 0 ? ` (${skipped.join(', ')} not in tree — pre-standard tree)` : ''
        }`
      : failures[0]!.error,
    counts: tests !== undefined ? { ...counts, tests } : counts,
    ...(failures.length > 0 ? { failures } : {}),
  };
  return {
    ok: true,
    resultType: 'app_gate',
    data: { slug, tree, envelope },
  } satisfies AppGateSuccess;
}

export function checkApp(deps: GateDeps, slug: string): Promise<AppGateResult> {
  return runGate(deps, slug, CHECK_STAGES);
}

export function buildApp(deps: GateDeps, slug: string): Promise<AppGateResult> {
  return runGate(deps, slug, BUILD_STAGES);
}
