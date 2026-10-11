// releases.ts — the management page's domain (docs/management-page.md):
// the ENFORCEMENT (the one unmodifiable part — a patch authored inside
// the container may never change the protected set), the read-only git
// view of the workspace checkout, release bookkeeping in the state db,
// the builder marker protocol, and the swap decision (which dist web
// serves at boot, plus the self-exit restart trigger).
//
// SECURITY INVARIANT — why this works at all:
//   - this module, its routes (src/pages/api/management/) and everything
//     else in PROTECTED_ENTRIES below are served from the image's
//     ROOT-OWNED /opt/web-pi copy; a pi session (uid 2000, workspace
//     container) can neither write them nor the state db on /state;
//   - the enforcement base is a chain rooted in root-owned facts (the
//     image's baked version.json, then pointer writes this code itself
//     makes — see currentBaseSha) and is resolved in the checkout by
//     git's content addressing; a rewritten history cannot forge the
//     base, and a missing base REFUSES (fail closed) instead of guessing;
//   - every dangerous verb re-runs the enforcement server-side; the
//     page's display is a courtesy, never the check.
// Residual risks (named, not hidden): docs/management-page.md §1.5.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { databaseRead, databaseUpdate, qb, type ReleaseStatus, type StateDb } from './db';
import { appVersion } from './settings';
import type { VerifyLoginResult } from './auth';
import type {
  BuildStatus, ChangedPath, CheckoutInfo, CommitEntry, EnforcementVerdict, ImageVersion,
  ManagementState, ReleaseRecord,
} from './types';
import type { CommitSha } from '../types/branded';
import type { ResultFailure, ResultSuccess } from '../types/result';
import {
  BuildDoneMarkerSchema, BuildRequestMarkerSchema, ReleaseManifestSchema, SHA_RE,
} from '../schemas/management';

// ---------- the protected set (docs/management-page.md §1.1) ----------
// The exact list the enforcement judges against. Changing an entry here
// is a change to the security boundary: it can only be made in the
// original project on the host, never applied from inside the container
// (this file is itself protected, below).
export interface ProtectedEntry { path: string; why: string }

export const PROTECTED_ENTRIES: readonly ProtectedEntry[] = [
  { path: 'compose.yaml', why: 'the split\'s definition: uids, :ro mounts, internal networks, restart policy, the builder service' },
  { path: 'Dockerfile', why: 'image construction: root-owned /opt/web-pi, uid 2000/gid 2001, entrypoints, version.json' },
  { path: 'docker-entrypoint.sh', why: 'the web container\'s entrypoint' },
  { path: 'docker-workspace-entrypoint.sh', why: 'the workspace entrypoint: tmux ownership, server-access admission, umask, socket perms' },
  { path: 'deploy', why: 'the perimeter: nginx TLS/WS proxying and fail2ban' },
  { path: '.gitmodules', why: 'names external sources of code that enter the tree at checkout time' },
  { path: 'package.json', why: 'build scripts and dependency declarations — what the builder runs' },
  { path: 'package-lock.json', why: 'pins every dependency and their install scripts' },
  { path: 'astro.config.mjs', why: 'executed as code at build time; adapter and body-size config' },
  { path: 'tsconfig.json', why: 'what the build compiles' },
  { path: 'tsconfig.server.json', why: 'the server build\'s inputs' },
  { path: 'server/main.ts', why: 'the gate: origin check, session check, body caps, security headers, WS bridge' },
  { path: 'server/set-password.ts', why: 'credential machinery (the setCredential CLI)' },
  { path: 'src/middleware.ts', why: 'the fail-closed guard for /api and /partials without locals' },
  { path: 'src/lib/auth.ts', why: 'login verification, the persisted session store, setCredential' },
  { path: 'src/lib/env-schema.ts', why: 'the WEB_PI_* contract every runtime knob is declared in' },
  { path: 'src/lib/env.ts', why: 'the runtime reader: which socket, paths and endpoints are trusted' },
  { path: 'src/lib/services.ts', why: 'the capability broker: what release code may call' },
  { path: 'src/lib/releases.ts', why: 'this module: the protected set, the enforcement, the swap' },
  { path: 'src/schemas/api.ts', why: 'the login wire schema' },
  { path: 'src/pages/api/management', why: 'the routes that drive apply — they call the enforcement' },
] as const;

// ---------- path normalization + matching (pure — unit-tested) ----------

/** Normalize one git path for matching. Returns the clean relative POSIX
 *  path, or null when the shape is one git never mints (absolute, `..`,
 *  backslash, NUL, empty) — the caller refuses on null (fail closed).
 *  Collapses `//` and strips `.` segments so `./compose.yaml` and
 *  `a//b` cannot dodge the exact-match below. */
export function normalizeGitPath(p: string): string | null {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return null;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue; // collapse //, strip ./ and trailing /
    if (seg === '..') return null;
    out.push(seg);
  }
  return out.length === 0 ? null : out.join('/');
}

/** The protected entry a (normalized) path matches, or null — the one
 *  definition of "inside the protected set" both predicates below use. */
function matchingProtectedEntry(normalized: string): ProtectedEntry | null {
  for (const entry of PROTECTED_ENTRIES) {
    if (normalized === entry.path || normalized.startsWith(entry.path + '/')) return entry;
  }
  return null;
}

/** Does this (normalized) path sit inside the protected set? Exact file
 *  match, or anything under a protected directory. Case-sensitive by
 *  design: the container fs is case-sensitive, git paths are exact, and
 *  `--no-renames` already surfaces a case-variant rename as delete+add
 *  on the protected path itself (docs/management-page.md §1.3). */
export function isProtectedPath(normalized: string): boolean {
  return matchingProtectedEntry(normalized) !== null;
}

/** The rationale for a protected hit (the matching entry's why), or null
 *  when the path is not in the set (an unparsable-path placeholder). */
export function protectedEntryWhy(normalized: string): string | null {
  return matchingProtectedEntry(normalized)?.why ?? null;
}

/** The protected-set hits among (normalized) paths, deduped and sorted —
 *  never capped: the verdict must consider every path. */
export function protectedHits(paths: Iterable<string>): string[] {
  const hits = new Set<string>();
  for (const p of paths) if (isProtectedPath(p)) hits.add(p);
  return [...hits].sort();
}

// ---------- diff parsing (pure — unit-tested) ----------

/** One `--name-status` record. With --no-renames, R/C never occur; the
 *  parser still accepts them (judging BOTH ends) rather than trusting
 *  that — defense in depth against a flag regression. */
export interface DiffRecord { letter: string; path: string; oldPath: string | null }

const ONE_PATH = /^[ADMT]$/;    // added, deleted, modified, type-changed
const TWO_PATH = /^[RC]\d+$/;   // rename/copy with similarity — defensive

/** Parse `git diff --no-renames --name-status -z` output. NUL-separated
 *  records: a status token, then one path (A/D/M/T) or two (R100/C75 —
 *  old, new). Paths are verbatim (-z): spaces, newlines and leading `-`
 *  are data, never delimiters. Returns null on anything unexpected — an
 *  unknown status letter, a truncated record — and the caller FAILS
 *  CLOSED (refuses to apply): a diff we cannot parse is a diff we cannot
 *  trust. */
export function parseNameStatus(raw: string): DiffRecord[] | null {
  const tokens = raw.split('\0');
  const records: DiffRecord[] = [];
  let i = 0;
  while (i < tokens.length) {
    const letter = tokens[i];
    if (letter === undefined || letter === '') { i++; continue; } // trailing NUL / empty runs
    if (ONE_PATH.test(letter)) {
      const p = tokens[i + 1];
      if (p === undefined || p === '') return null;
      records.push({ letter, path: p, oldPath: null });
      i += 2;
    } else if (TWO_PATH.test(letter)) {
      const oldPath = tokens[i + 1], p = tokens[i + 2];
      if (oldPath === undefined || p === undefined || p === '') return null;
      records.push({ letter, path: p, oldPath });
      i += 3;
    } else {
      return null; // unknown record shape — fail closed
    }
  }
  return records;
}

/** Display form of a record (letter → the A/D/M/T the page shows). */
function displayStatus(letter: string): ChangedPath['status'] {
  if (letter === 'A' || letter === 'D' || letter === 'M' || letter === 'T') return letter;
  return 'M'; // R*/C* halves are displayed as modifications of both ends
}

/** Cap on the changed-path list carried for display (the VERDICT always
 *  considers every path; only the list shown to the human is capped). */
export const PREVIEW_PATH_CAP = 200;

/** The verdict from parsed records: which paths changed, which hits the
 *  protected set, and whether apply is allowed. Pure. */
export function verdictFromRecords(base: string, target: string, records: DiffRecord[]): EnforcementVerdict {
  const changed: ChangedPath[] = [];
  const protectedChanged = new Set<string>();
  let judged = 0;
  // Every end of every record is judged (a rename's old path AND new
  // path): renames into and out of the protected set are both caught.
  const judge = (raw: string, status: ChangedPath['status']): void => {
    judged++;
    const normalized = normalizeGitPath(raw);
    // An unnormalizable path is one git never mints: count it as a
    // protected hit so the verdict can never be "allowed" on garbage.
    if (normalized === null) { protectedChanged.add(`<unparsable path: ${raw}>`); return; }
    if (isProtectedPath(normalized)) protectedChanged.add(normalized);
    if (changed.length < PREVIEW_PATH_CAP) {
      changed.push({ path: normalized, status, protectedPath: isProtectedPath(normalized) });
    }
  };
  for (const r of records) {
    judge(r.path, displayStatus(r.letter));
    if (r.oldPath !== null) judge(r.oldPath, 'D');
  }
  const hits = [...protectedChanged].sort();
  // (an unparsable-path placeholder matches no entry → no rationale)
  const protectedWhy: Record<string, string> = {};
  for (const p of hits) {
    const why = protectedEntryWhy(p);
    if (why !== null) protectedWhy[p] = why;
  }
  return {
    base, target,
    allowed: protectedChanged.size === 0,
    changedCount: judged,
    changed,
    protectedChanged: hits,
    protectedWhy,
  };
}

// ---------- result families (statuses mapped in responses.service.ts) ----------

export type ManagementStateData = ManagementState;
export type ManagementStateErrorCode = 'database_error';
export type ManagementStateSuccess = ResultSuccess<'management_state', ManagementStateData>;
export type ManagementStateFailure = ResultFailure<'management_state', ManagementStateData, ManagementStateErrorCode>;
export type ManagementStateResult = ManagementStateSuccess | ManagementStateFailure;

export type ListCommitsData = { commits: CommitEntry[] };
/** checkout_missing: WEB_PI_MANAGEMENT_CHECKOUT unset or the dir absent
 *  (the page shows the clone/enable guidance). git_error: git itself
 *  failed — not a repository, timeout, unreadable. */
export type ListCommitsErrorCode = 'checkout_missing' | 'git_error';
export type ListCommitsSuccess = ResultSuccess<'list_commits', ListCommitsData>;
export type ListCommitsFailure = ResultFailure<'list_commits', ListCommitsData, ListCommitsErrorCode>;
export type ListCommitsResult = ListCommitsSuccess | ListCommitsFailure;

/** Why the enforcement could not be computed (docs/management-page.md
 *  §1.2): without a trustworthy base there is no enforcement, so every
 *  code here refuses rather than guessing. */
export type EnforcementErrorCode =
  | 'checkout_missing'    // no checkout configured/present
  | 'base_unknown'        // the running copy records no git sha (rebuild the image with GIT_SHA)
  | 'base_not_in_checkout'// the base sha does not resolve in the checkout (rewritten history / wrong repo)
  | 'target_not_found'    // the picked sha does not resolve
  | 'git_error';          // git failed (incl. an unparseable diff — fail closed)
export type EnforcementData = EnforcementVerdict;
export type EnforcementSuccess = ResultSuccess<'enforcement_preview', EnforcementData>;
export type EnforcementFailure = ResultFailure<'enforcement_preview', EnforcementData, EnforcementErrorCode>;
export type EnforcementResult = EnforcementSuccess | EnforcementFailure;

export type RequestBuildData = { sha: CommitSha; status: 'requested' };
export type RequestBuildErrorCode =
  | 'invalid_credentials'  // the password re-confirmation failed (401)
  | 'enforcement_rejected' // the diff touches the protected set (422; data carries the verdict)
  | 'releases_not_configured' // no WEB_PI_RELEASES_DIR volume (503)
  | 'build_active'         // another build is pending/running (409)
  | 'marker_error'         // the request marker could not be written (500)
  | 'database_error'
  | EnforcementErrorCode;
export type RequestBuildSuccess = ResultSuccess<'request_build', RequestBuildData>;
export type RequestBuildFailure = ResultFailure<'request_build', RequestBuildData, RequestBuildErrorCode>;
export type RequestBuildResult = RequestBuildSuccess | RequestBuildFailure;

export type ActivateData = { target: 'image' | CommitSha; status: 'activating' };
export type ActivateErrorCode =
  | 'invalid_credentials'
  | 'enforcement_rejected'
  | 'releases_not_configured'
  | 'release_not_built'   // no built release for that sha (404)
  | 'release_invalid'     // manifest mismatch / layout invalid (409)
  | 'database_error'
  | EnforcementErrorCode;
export type ActivateSuccess = ResultSuccess<'activate_release', ActivateData>;
export type ActivateFailure = ResultFailure<'activate_release', ActivateData, ActivateErrorCode>;
export type ActivateResult = ActivateSuccess | ActivateFailure;

// ---------- the image's baked version (docs/management-page.md §1.2) ----------

/** The image identity recorded at docker build (version.json at the app
 *  root: {"git": "<sha>", "builtAt": "<iso>"}). Read per call (cheap) so
 *  tests and a re-baked image are picked up without restart quirks.
 *  Can't fail: absent/invalid reads as null (→ base_unknown upstream). */
export function readImageVersion(appRoot: string): { git: string; builtAt: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(appRoot, 'version.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { git, builtAt } = parsed as Record<string, unknown>;
  if (typeof git !== 'string' || git === '') return null;
  return { git, builtAt: typeof builtAt === 'string' ? builtAt : null };
}

// ---------- git boundary (execFile; argv arrays only, never a shell) ----------

const GIT_TIMEOUT_MS = 15_000;

/** One git call in the checkout. Never rejects: the error (with git's
 *  stderr) is part of the answer. `safe.directory='*'` per-invocation is
 *  required — web (uid node) reads a uid-2000-owned repo across the :ro
 *  mount and git refuses "dubious ownership" otherwise — and must be a
 *  `-c` flag (there is nowhere web may write config). Ambient config is
 *  neutralized in the child env so nothing in $HOME or /etc can steer
 *  git's behavior between calls. `--no-replace-objects` (flag + env,
 *  both) is load-bearing for the enforcement itself: the checkout's
 *  owner can mint `refs/replace/<sha> → <any object>` (§0: rewritten
 *  refs are fair game), and git honors them on EVERY object lookup
 *  unless told not to — a replace of the base with the target would
 *  make the diff empty, a replace of the target would archive/serve
 *  another tree under a sha the enforcement approved (docs/
 *  management-page.md §1.2–1.3; unit-tested from the attacker's side). */
function git(checkout: string, args: string[]): Promise<{ error: Error | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile('git', ['--no-replace-objects', '-c', 'safe.directory=*', '--no-pager', ...args], {
      cwd: checkout,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
      },
    }, (err, stdout, stderr) => resolve({
      error: err instanceof Error ? err : null,
      stdout: typeof stdout === 'string' ? stdout : '',
      stderr: typeof stderr === 'string' ? stderr : '',
    }));
  });
}

function gitError(what: string, error: Error | null, stderr: string): string {
  const detail = stderr.trim().split('\n')[0] ?? '';
  return `git ${what} failed: ${detail || (error?.message ?? 'unknown error')}`;
}

/** Does the checkout dir exist and hold a git repository we can read?
 *  `rev-parse --git-dir` against a real repo answers its path even when
 *  HEAD is broken; missing dir → checkout_missing, anything else →
 *  git_error with git's own words. */
async function requireCheckout(checkout: string | null):
  Promise<{ ok: true; checkout: string } | { ok: false; errorCode: 'checkout_missing' | 'git_error'; errorMessage: string }> {
  if (checkout === null) {
    return { ok: false, errorCode: 'checkout_missing', errorMessage: 'WEB_PI_MANAGEMENT_CHECKOUT is not set — point it at the workspace checkout (compose: /workspace/web-pi)' };
  }
  if (!fs.existsSync(checkout)) {
    return { ok: false, errorCode: 'checkout_missing', errorMessage: `the workspace checkout ${checkout} does not exist — clone one (docker compose exec workspace git clone <fork> /workspace/web-pi)` };
  }
  const { error, stderr } = await git(checkout, ['rev-parse', '--git-dir']);
  if (error) return { ok: false, errorCode: 'git_error', errorMessage: gitError('rev-parse', error, stderr) };
  return { ok: true, checkout };
}

/** Does `sha` resolve as a commit object in the checkout? Content
 *  addressing makes a resolvable sha trustworthy (the tree is the tree
 *  that was recorded). */
async function commitExists(checkout: string, sha: string): Promise<boolean> {
  const { error } = await git(checkout, ['cat-file', '-e', `${sha}^{commit}`]);
  return !error;
}

/** Read-only facts about the checkout for the page. Soft by design: git
 *  problems land in `error` (data), never as a family failure — the
 *  state card shows them instead of guessing. */
export async function checkoutInfo(checkout: string | null): Promise<CheckoutInfo | null> {
  if (checkout === null) return null;
  const info: CheckoutInfo = { path: checkout, head: null, branch: null, dirty: null, error: null };
  if (!fs.existsSync(checkout)) {
    info.error = `the workspace checkout ${checkout} does not exist — clone one first`;
    return info;
  }
  const head = await git(checkout, ['rev-parse', 'HEAD']);
  if (head.error) { info.error = gitError('rev-parse', head.error, head.stderr); return info; }
  info.head = head.stdout.trim() || null;
  const branch = await git(checkout, ['symbolic-ref', '--short', 'HEAD']);
  info.branch = branch.error ? null : (branch.stdout.trim() || null); // detached → null
  const status = await git(checkout, ['status', '--porcelain']);
  if (!status.error) info.dirty = status.stdout.split('\n').filter(Boolean).length;
  return info;
}

/** Recent commits of the checkout (newest first), for the picker. */
export async function listCommitsRaw(checkout: string | null, max = 50): Promise<CommitEntry[]> {
  const out: CommitEntry[] = [];
  const { error, stdout, stderr } = await git(checkout as string,
    ['log', `-z`, `--max-count=${max}`, '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI']);
  if (error) throw new Error(gitError('log', error, stderr));
  for (const entry of stdout.split('\0')) {
    if (!entry) continue;
    const [sha, short, subject, author, date] = entry.split('\x1f');
    if (!sha || !short) continue;
    out.push({
      sha, short, subject: subject ?? '', author: author ?? '', date: date ?? '',
    });
  }
  return out;
}

/** The enforcement itself: diff base..target in the checkout and judge
 *  every changed path against the protected set. Runs in this (root-
 *  owned, image-resident) code for the preview AND re-runs before every
 *  dangerous verb — the page never decides anything. */
export async function enforceDiff(checkout: string, base: CommitSha, target: CommitSha):
  Promise<EnforcementResult> {
  const fail = (errorCode: EnforcementErrorCode, errorMessage: string): EnforcementFailure =>
    ({ ok: false, resultType: 'enforcement_preview', errorCode, errorMessage });
  if (!(await commitExists(checkout, base))) {
    return fail('base_not_in_checkout',
      `the running version's commit ${base} does not resolve in ${checkout} — the checkout's history was rewritten or it is a different repository; refusing to apply (docs/management-page.md §1.2)`);
  }
  if (!(await commitExists(checkout, target))) {
    return fail('target_not_found', `commit ${target} does not resolve in ${checkout}`);
  }
  const { error, stdout, stderr } = await git(checkout,
    ['diff', '--no-renames', '--name-status', '-z', base, target]);
  if (error) return fail('git_error', gitError('diff', error, stderr));
  const records = parseNameStatus(stdout);
  if (records === null) return fail('git_error', 'the diff output could not be parsed — refusing to apply (fail closed)');
  return { ok: true, resultType: 'enforcement_preview', data: verdictFromRecords(base, target, records) };
}

// ---------- the served-release pointer (docs/management-page.md §3.2) ----------

/** The pointer file: <releases>/pointer/current, holding the sha the
 *  NEXT boot serves (absent → the image copy). Lives in a web-only
 *  subdir (0750 node:node) of the releases volume — not the db (whose
 *  lazy open must stay lazy, db.ts) and not the group-writable volume
 *  root (the builder shares a group with web, sessions share a uid with
 *  the builder — the pointer is the one thing ONLY web may write, which
 *  is what makes it a trustworthy diff base). */
export function pointerPath(releasesDir: string): string {
  return path.join(releasesDir, 'pointer', 'current');
}

/** The sha the next boot will serve, or null (image copy / unreadable /
 *  not a sha — never guesses). Can't fail: a bad pointer reads as absent. */
export function readPointer(releasesDir: string | null): string | null {
  if (releasesDir === null) return null;
  try {
    const raw = fs.readFileSync(pointerPath(releasesDir), 'utf8').trim();
    return SHA_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Write (sha) or clear (null) the pointer, atomically — tmp + rename, so
 *  a boot or a crash never reads a half-written target. Throws on fs
 *  failure; callers wrap it as database_error-shaped failures. */
export function writePointer(releasesDir: string, sha: string | null): void {
  const file = pointerPath(releasesDir);
  // (mode 0750 applies only when the dir is created here — in compose
  //  releases-init owns the pointer volume's mode)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  if (sha === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, sha, { mode: 0o640 });
  fs.renameSync(tmp, file);
}

/** The base every diff is computed against: the pointer this code last
 *  wrote (trusted — the pointer dir is web-only writable), else the
 *  image's baked sha. Null when neither yields a full sha → callers
 *  answer base_unknown instead of diffing against a guess. */
export function currentBaseSha(appRoot: string, releasesDir: string | null): CommitSha | null {
  const pointed = readPointer(releasesDir);
  if (pointed !== null) return pointed as CommitSha;
  const image = readImageVersion(appRoot);
  return image && SHA_RE.test(image.git) ? (image.git as CommitSha) : null;
}

export interface MarkerPaths { pending: string; building: string; done: string; releaseDir: string }

export function markerPaths(releasesDir: string, sha: string): MarkerPaths {
  return {
    pending: path.join(releasesDir, 'pending', `${sha}.json`),
    building: path.join(releasesDir, 'building', `${sha}.json`),
    done: path.join(releasesDir, 'done', `${sha}.json`),
    releaseDir: path.join(releasesDir, sha),
  };
}

/** The live build state for one sha, from the marker files (the builder's
 *  side of the protocol). Unreadable JSON in done/<sha>.json reads as
 *  failed — the page must never wait forever on a corrupt answer. */
export function readBuildMarker(releasesDir: string, sha: string): { status: BuildStatus; log: string | null } {
  const p = markerPaths(releasesDir, sha);
  if (fs.existsSync(p.done)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(p.done, 'utf8'));
    } catch {
      return { status: 'failed', log: 'the builder\'s done marker is not valid JSON' };
    }
    const marker = BuildDoneMarkerSchema.safeParse(parsed);
    if (!marker.success || marker.data.sha !== sha) {
      return { status: 'failed', log: 'the builder\'s done marker does not match the schema' };
    }
    return { status: marker.data.status, log: marker.data.log };
  }
  if (fs.existsSync(p.building)) return { status: 'building', log: null };
  if (fs.existsSync(p.pending)) return { status: 'pending', log: null };
  return { status: 'none', log: null };
}

/** Is any build in flight (one at a time — the builder works serially)? */
export function anyBuildActive(releasesDir: string): boolean {
  for (const dir of ['pending', 'building']) {
    try {
      if ((fs.readdirSync(path.join(releasesDir, dir))).some(f => f.endsWith('.json'))) return true;
    } catch { /* absent dir = nothing in flight */ }
  }
  return false;
}

/** Write the request marker atomically (tmp + rename) so the builder
 *  never reads a half-written request. Throws on fs failure — callers
 *  wrap it as marker_error (the boundary). */
export function writeBuildRequest(releasesDir: string, sha: string, base: string): void {
  const p = markerPaths(releasesDir, sha);
  const body = JSON.stringify(
    BuildRequestMarkerSchema.parse({ sha, base, requestedAt: Date.now() }));
  fs.mkdirSync(path.dirname(p.pending), { recursive: true });
  fs.writeFileSync(p.pending, body, { mode: 0o660 });
}

/** A release dir's layout: what activate accepts and boot serves.
 *  manifest.sha must equal the target (the builder cannot mislabel a
 *  release as another sha) and dist/ must hold the Astro entry + client
 *  assets. Never throws: reasons come back as strings. */
export function validateReleaseDir(releaseDir: string, sha: string): { ok: true } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
  } catch {
    return { ok: false, reason: `no readable manifest.json in ${releaseDir}` };
  }
  const manifest = ReleaseManifestSchema.safeParse(parsed);
  if (!manifest.success) return { ok: false, reason: `manifest.json does not match the schema` };
  if (manifest.data.sha !== sha) {
    return { ok: false, reason: `manifest sha ${manifest.data.sha} ≠ ${sha} — the release dir is not what it claims` };
  }
  if (!fs.existsSync(path.join(releaseDir, 'dist', 'server', 'entry.mjs'))) {
    return { ok: false, reason: `dist/server/entry.mjs is missing in ${releaseDir}` };
  }
  const client = path.join(releaseDir, 'dist', 'client');
  if (!fs.existsSync(client) || (fs.readdirSync(client)).length === 0) {
    return { ok: false, reason: `dist/client is missing or empty in ${releaseDir}` };
  }
  return { ok: true };
}

// ---------- boot-time serve resolution (docs/management-page.md §3.2) ----------

export interface ServeDirs {
  /** Astro hashed assets root */
  clientDir: string;
  /** Astro SSR handler (dist/server/entry.mjs) */
  astroEntry: string;
  /** the release dir in use, null when serving the image copy */
  releaseDir: string | null;
  /** the served release's sha, null when serving the image copy */
  sha: string | null;
}

/** What this boot serves: the release the pointer names, when a valid one
 *  exists, else the image copy. Never throws — an invalid/missing
 *  release falls back to the image (the running process must always be
 *  able to serve SOMETHING; the fallback is logged loudly by the caller).
 *  Reads only the pointer file — deliberately NOT the state db, whose
 *  connection opens lazily on first use and must stay that way (db.ts). */
export function resolveServingDirs(opts: {
  imageClientDir: string;
  imageAstroEntry: string;
  releasesDir: string | null;
}): { dirs: ServeDirs; note: string } {
  const current = readPointer(opts.releasesDir);
  if (opts.releasesDir !== null && current !== null) {
    const releaseDir = path.join(opts.releasesDir, current);
    const valid = validateReleaseDir(releaseDir, current);
    if (valid.ok) {
      return {
        dirs: {
          clientDir: path.join(releaseDir, 'dist', 'client'),
          astroEntry: path.join(releaseDir, 'dist', 'server', 'entry.mjs'),
          releaseDir,
          sha: current,
        },
        note: `serving release ${current} from ${releaseDir}`,
      };
    }
    if (fs.existsSync(releaseDir)) {
      return { dirs: imageDirs(opts), note: `release ${current} is INVALID (${valid.reason}) — falling back to the image copy` };
    }
    return { dirs: imageDirs(opts), note: `release ${current} is missing — falling back to the image copy` };
  }
  return { dirs: imageDirs(opts), note: 'serving the image copy' };
}

function imageDirs(opts: { imageClientDir: string; imageAstroEntry: string }): ServeDirs {
  return { clientDir: opts.imageClientDir, astroEntry: opts.imageAstroEntry, releaseDir: null, sha: null };
}

// ---------- the service (one instance, built by server/main.ts via services.ts) ----------

const HISTORY_CAP = 20;
const LOG_CAP = 8 * 1024;

export interface ReleasesDeps {
  db: StateDb;
  /** the workspace checkout (WEB_PI_MANAGEMENT_CHECKOUT), read-only on web's mount */
  checkout: string | null;
  /** the releases volume (WEB_PI_RELEASES_DIR); null = swap half off */
  releasesDir: string | null;
  appRoot: string;
  /** What THIS boot resolved to serve (server/main.ts's boot snapshot) —
   *  the honest "serving now"; the pointer file may name a newer target
   *  for the next boot. */
  bootServing: { kind: 'image' | 'release'; sha: string | null };
  /** graceful-restart trigger (server/main.ts's shutdown path) */
  requestRestart: () => void;
  /** login re-verification for the dangerous verbs (auth.verify) */
  verify: (username: string, password: string) => Promise<VerifyLoginResult>;
}

interface ReleaseRow {
  sha: string; status: ReleaseStatus; requested_at: number;
  built_at: number | null; applied_at: number | null; log: string | null;
}

/** The management page's service. All state lives in the state db and on
 *  the releases volume; this class is stateless between calls. */
export class Releases {
  constructor(private deps: ReleasesDeps) {}

  /** History rows, newest first (a failure on a db read). */
  private dbRows(): ReleaseRow[] | ManagementStateFailure {
    const read = databaseRead('could not read releases', (): ReleaseRow[] =>
      this.deps.db.all(qb.selectFrom('releases')
        .select(['sha', 'status', 'requested_at', 'built_at', 'applied_at', 'log'])
        .orderBy('requested_at', 'desc').limit(HISTORY_CAP)));
    return read.ok ? read.data.value
      : { ok: false, resultType: 'management_state', errorCode: 'database_error', errorMessage: read.errorMessage };
  }

  /** GET /api/management: everything the page renders. Only the db read
   *  can fail (git problems land in the checkout card as data). */
  async state(): Promise<ManagementStateResult> {
    const fail = (errorMessage: string): ManagementStateFailure =>
      ({ ok: false, resultType: 'management_state', errorCode: 'database_error', errorMessage });
    // Pull the builder's answers for in-flight builds into the history
    // rows first, so the recorded outcome outlives the marker files.
    const before = this.dbRows();
    if (Array.isArray(before)) {
      for (const row of before) {
        if (row.status === 'requested') this.syncMarkerToDb(row.sha);
      }
    }
    const rows = this.dbRows();
    if (!Array.isArray(rows)) return fail(rows.errorMessage ?? 'could not read the release history');
    const image = readImageVersion(this.deps.appRoot);
    const releases: ReleaseRecord[] = rows.map(r => {
      const record: ReleaseRecord = {
        sha: r.sha, status: r.status, requestedAt: r.requested_at,
        builtAt: r.built_at, appliedAt: r.applied_at, log: r.log,
      };
      if (r.status === 'requested' && this.deps.releasesDir !== null) {
        const marker = readBuildMarker(this.deps.releasesDir, r.sha);
        if (marker.status !== 'none') record.live = marker.status;
      }
      return record;
    });
    // "serving now" is what the process resolved at boot (honest even
    // when a pointer write is waiting for the restart); `nextBoot` says
    // so when the pointer has moved past it.
    const serving: ManagementState['serving'] = {
      kind: this.deps.bootServing.kind,
      image: image === null ? null
        : { appVersion: appVersion(this.deps.appRoot), git: image.git, builtAt: image.builtAt },
      release: this.deps.bootServing.kind === 'release' && this.deps.bootServing.sha !== null
        ? { sha: this.deps.bootServing.sha,
            builtAt: this.deps.releasesDir === null ? null
              : (readReleaseManifest(path.join(this.deps.releasesDir, this.deps.bootServing.sha))?.builtAt ?? null) }
        : null,
    };
    const pointed = readPointer(this.deps.releasesDir);
    const bootSha = this.deps.bootServing.sha;
    const nextBoot: ManagementState['nextBoot'] =
      pointed !== null && pointed !== bootSha ? { kind: 'release', sha: pointed } : null;
    return {
      ok: true, resultType: 'management_state',
      data: {
        me: 'ok',
        serving,
        nextBoot,
        checkout: await checkoutInfo(this.deps.checkout),
        releasesDir: this.deps.releasesDir,
        releases,
      },
    } satisfies ManagementStateSuccess;
  }

  /** GET /api/management/commits — the picker list. */
  async commits(): Promise<ListCommitsResult> {
    const ready = await requireCheckout(this.deps.checkout);
    if (!ready.ok) {
      return { ok: false, resultType: 'list_commits', errorCode: ready.errorCode, errorMessage: ready.errorMessage };
    }
    try {
      const commits = await listCommitsRaw(ready.checkout);
      return { ok: true, resultType: 'list_commits', data: { commits } } satisfies ListCommitsSuccess;
    } catch (err) {
      return { ok: false, resultType: 'list_commits', errorCode: 'git_error', errorMessage: (err as Error).message };
    }
  }

  /** GET /api/management/preview — the dry-run verdict BEFORE any verb. */
  async preview(sha: CommitSha): Promise<EnforcementResult> {
    return this.enforce(sha);
  }

  /** The shared enforcement path: base chain → resolve both ends → diff
   *  → verdict. Refuses (never guesses) on any gap. */
  private async enforce(target: CommitSha): Promise<EnforcementResult> {
    const ready = await requireCheckout(this.deps.checkout);
    if (!ready.ok) {
      return { ok: false, resultType: 'enforcement_preview', errorCode: ready.errorCode, errorMessage: ready.errorMessage };
    }
    const base = currentBaseSha(this.deps.appRoot, this.deps.releasesDir);
    if (base === null) {
      return {
        ok: false, resultType: 'enforcement_preview', errorCode: 'base_unknown',
        errorMessage: 'the running copy does not record its source git sha — rebuild the image with GIT_SHA=$(git rev-parse HEAD) docker compose build (docs/management-page.md §1.2); refusing to apply',
      };
    }
    return enforceDiff(ready.checkout, base, target);
  }

  /** POST /api/management/build — re-auth, enforce, then hand the sha to
   *  the builder via the pending marker. The BUILD runs workspace-side;
   *  this side only writes the request and records it. */
  async requestBuild(input: { sha: CommitSha; username: string; password: string }): Promise<RequestBuildResult> {
    const { sha } = input;
    const fail = (errorCode: RequestBuildErrorCode, errorMessage: string, data?: RequestBuildData): RequestBuildFailure =>
      data === undefined
        ? { ok: false, resultType: 'request_build', errorCode, errorMessage }
        : { ok: false, resultType: 'request_build', data, errorCode, errorMessage };
    const verified = await this.deps.verify(input.username, input.password);
    if (!verified.ok) {
      return fail('invalid_credentials',
        verified.errorCode === 'database_error'
          ? 'could not verify the password — try again'
          : 'wrong username or password');
    }
    if (this.deps.releasesDir === null) {
      return fail('releases_not_configured',
        'the releases volume is not mounted — add the WEB_PI_RELEASES_DIR wiring (docs/management-page.md §7) and docker compose up -d');
    }
    const verdict = await this.enforce(sha);
    if (!verdict.ok) return fail(verdict.errorCode, verdict.errorMessage ?? verdict.errorCode);
    if (!verdict.data.allowed) {
      return fail('enforcement_rejected',
        `refused: the diff ${verdict.data.base.slice(0, 12)}…→${sha.slice(0, 12)}… changes the protected set (${verdict.data.protectedChanged.join(', ')}) — that part of the software is only modifiable in the original project on the host (docs/management-page.md §1.1)`,
        { sha, status: 'requested' });
    }
    if (anyBuildActive(this.deps.releasesDir)) {
      return fail('build_active', 'another build is pending or running — wait for it to finish');
    }
    try {
      writeBuildRequest(this.deps.releasesDir, sha, verdict.data.base);
    } catch (err) {
      return fail('marker_error', `could not write the build request: ${(err as Error).message}`);
    }
    const saved = databaseUpdate('could not record the build request', () =>
      this.deps.db.run(qb.insertInto('releases')
        .values({ sha, status: 'requested', requested_at: Date.now(), built_at: null, applied_at: null, log: null })
        .onConflict(oc => oc.column('sha').doUpdateSet(eb => ({
          status: eb.ref('excluded.status'), requested_at: eb.ref('excluded.requested_at'),
          built_at: eb.ref('excluded.built_at'), applied_at: eb.ref('excluded.applied_at'), log: eb.ref('excluded.log'),
        })))));
    if (!saved.ok) return fail('database_error', saved.errorMessage, { sha, status: 'requested' });
    console.log(`management: build requested for ${sha.slice(0, 12)}… (base ${verdict.data.base.slice(0, 12)}…)`);
    return { ok: true, resultType: 'request_build', data: { sha, status: 'requested' } } satisfies RequestBuildSuccess;
  }

  /** POST /api/management/activate — the swap/rollback: validate the
   *  release (re-running the enforcement for a release target), write the
   *  pointer, record history, and trigger the graceful restart that
   *  makes the next boot serve it. Target 'image' rolls back to the
   *  image copy (needs no releases volume). */
  async activate(input: { target: 'image' | CommitSha; username: string; password: string }): Promise<ActivateResult> {
    const { target } = input;
    const fail = (errorCode: ActivateErrorCode, errorMessage: string): ActivateFailure =>
      ({ ok: false, resultType: 'activate_release', errorCode, errorMessage });
    const verified = await this.deps.verify(input.username, input.password);
    if (!verified.ok) {
      return fail('invalid_credentials',
        verified.errorCode === 'database_error'
          ? 'could not verify the password — try again'
          : 'wrong username or password');
    }
    const sha: CommitSha | null = target === 'image' ? null : target;
    if (sha !== null) {
      if (this.deps.releasesDir === null) {
        return fail('releases_not_configured',
          'the releases volume is not mounted — add the WEB_PI_RELEASES_DIR wiring (docs/management-page.md §7)');
      }
      // Enforcement re-run: the verdict the page showed is a courtesy;
      // this is the check. The base is the CURRENT pointer/image, so an
      // activate chained after another activate re-judges against what is
      // actually running.
      const verdict = await this.enforce(sha);
      if (!verdict.ok) return fail(verdict.errorCode, verdict.errorMessage ?? verdict.errorCode);
      if (!verdict.data.allowed) {
        return fail('enforcement_rejected',
          `refused: the diff ${verdict.data.base.slice(0, 12)}…→${sha.slice(0, 12)}… changes the protected set (${verdict.data.protectedChanged.join(', ')}) — only modifiable in the original project on the host`,
        );
      }
      const marker = readBuildMarker(this.deps.releasesDir, sha);
      if (marker.status !== 'built') {
        return fail('release_not_built',
          marker.status === 'failed'
            ? `the build of ${sha.slice(0, 12)}… failed — check its log on the page`
            : `no built release for ${sha.slice(0, 12)}… (build status: ${marker.status})`);
      }
      const valid = validateReleaseDir(path.join(this.deps.releasesDir, sha), sha);
      if (!valid.ok) return fail('release_invalid', valid.reason);
    }
    // Pointer + history, then the restart. The pointer write is the
    // atomic commit point: a crash before it changes nothing; after it,
    // the next boot serves the target.
    if (this.deps.releasesDir !== null) {
      try {
        writePointer(this.deps.releasesDir, sha);
      } catch (err) {
        return fail('database_error', `could not write the release pointer: ${(err as Error).message}`);
      }
    } else if (sha === null) {
      // No releases volume and rolling back to the image: the boot is
      // already serving the image copy — nothing to change, no restart.
      return { ok: true, resultType: 'activate_release', data: { target, status: 'activating' } } satisfies ActivateSuccess;
    }
    if (sha !== null) {
      const saved = databaseUpdate('could not record the activation', () =>
        this.deps.db.run(qb.updateTable('releases').set({ status: 'applied', applied_at: Date.now() })
          .where('sha', '=', sha)));
      if (!saved.ok) return fail('database_error', saved.errorMessage);
    }
    console.log(`management: ${sha === null ? 'rolling back to the image copy' : `activating release ${sha.slice(0, 12)}…`} — restarting`);
    this.deps.requestRestart();
    return {
      ok: true, resultType: 'activate_release',
      data: { target, status: 'activating' },
    } satisfies ActivateSuccess;
  }

  /** The build outcome as recorded when the builder answers (synced in
   *  by state(), so the history outlives the marker files). */
  private syncMarkerToDb(sha: string): void {
    if (this.deps.releasesDir === null) return;
    const marker = readBuildMarker(this.deps.releasesDir, sha);
    const outcome = marker.status === 'built' || marker.status === 'failed' ? marker.status : null;
    if (outcome === null) return;
    databaseUpdate('could not record the build outcome', () =>
      this.deps.db.run(qb.updateTable('releases')
        .set({ status: outcome, built_at: Date.now(), log: (marker.log ?? '').slice(0, LOG_CAP) })
        .where('sha', '=', sha)));
  }
}

/** manifest.json of a release dir, or null when unreadable/invalid. */
function readReleaseManifest(releaseDir: string): { sha: string; builtAt: number; builder: string } | null {
  try {
    const parsed = ReleaseManifestSchema.safeParse(
      JSON.parse(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
