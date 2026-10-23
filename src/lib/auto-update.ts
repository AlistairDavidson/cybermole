// auto-update.ts — the 'auto-update pi' setting (TODO top block): when ON,
// check for a newer pi WITHIN the range cybermole declares in package.json
// (read the way settings.ts's piDeclared does) and install it through the
// manual updater's machinery (runPiUpdate — shared busy guard, output
// capture, no restart). Default OFF; the toggle and the last outcomes live
// in the state db's settings kv, surfaced on /settings via /api/settings.
//
// SAFETY CHOICE vs the manual button: auto-update installs the newest
// version that SATISFIES the declared range (e.g. `npm install
// @earendil-works/pi-coding-agent@^1.0.1` — the range is derived from
// package.json, never hardcoded), where the button installs @latest with
// the README's 'stay within ^1' caveat. A pi above the declared range
// (installed by hand via the button) is left alone: latest-in-range <
// installed means no update, and auto-update never downgrades into range.
import { execFile } from 'node:child_process';
import { databaseRead, databaseUpdate, type StateDb } from './db';
import { componentLogger } from './logger';
import type { AutoUpdateCheck, AutoUpdateResult } from './types';
import { PI_PACKAGE, npmPath, piDeclared, piInstalled, runPiUpdate } from './settings';

const log = componentLogger('update');

// settings kv keys (db.ts settings table)
const KEY_ENABLED = 'piAutoUpdate.enabled';
const KEY_LAST_CHECK = 'piAutoUpdate.lastCheck';
const KEY_LAST_UPDATE = 'piAutoUpdate.lastUpdate';

export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VIEW_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 16 * 1024;

// ---------- pure decision logic (unit-tested with no npm, no db) ----------

/** Declared values that can act as an npm version RANGE. Deliberately
 *  narrow — digits, comparators, wildcards, range glue — so URLs, git
 *  refs, dist-tags (`latest`) and `unknown` all disqualify auto-update
 *  instead of being guessed at. */
const RANGE_RE = /^[\d.^~*<>=|\sxX-]+$/;

/** The npm spec that targets the newest pi WITHIN the declared range
 *  (`@earendil-works/pi-coding-agent@^1.0.1`), or null when the declared
 *  value can't be a range — an unusable declaration disables the check
 *  (recorded as a failed outcome) rather than installing anything. */
export function autoUpdateSpec(declared: string): string | null {
  const d = declared.trim();
  if (!d || !RANGE_RE.test(d)) return null;
  return `${PI_PACKAGE}@${d}`;
}

/** `major.minor.patch[-prerelease][+build]` as comparable parts, null if
 *  not a plain semver string. Build metadata is parsed and IGNORED, per
 *  semver precedence rules (1.2.3+abc ≡ 1.2.3). */
function parseSemver(v: string): [number, number, number, string[]] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? [] : m[4].split('.')];
}

/** A string that parses as a plain semver version. */
export function isPlainVersion(v: string): boolean {
  return parseSemver(v) !== null;
}

/** semver precedence: <0 when a<b, 0 when equal or UNPARSEABLE (an
 *  unparseable side never wins — the caller fails safe, no install). */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a),
    pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  }
  // no prerelease > any prerelease (1.0.0 > 1.0.0-beta)
  if (pa[3].length === 0 || pb[3].length === 0) return pb[3].length - pa[3].length;
  for (let i = 0; i < Math.max(pa[3].length, pb[3].length); i++) {
    const x = pa[3][i],
      y = pb[3][i];
    if (x === undefined) return -1; // shorter set of ids = lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric ids sort lower
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Install iff latest-in-range is strictly newer than what's installed.
 *  Not-installed counts as outdated; an unparseable installed version
 *  never does (compareVersions answers 0) — never touch what can't be
 *  reasoned about. */
export function shouldAutoUpdate(installed: string | null, latestInRange: string): boolean {
  return installed === null || compareVersions(latestInRange, installed) > 0;
}

/** The newest version out of `npm view <spec> version --json` output.
 *  npm answers a range spec with EVERY matching version, ascending
 *  (single match → a JSON string); the newest — what `npm install
 *  <spec>` would pick — is the max entry, by precedence not list order.
 *  Null when nothing in the output looks like a version. */
export function parseNpmViewVersion(out: string): string | null {
  const t = out.trim();
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    v = t;
  } // not json — try the plain form
  if (typeof v === 'string') return parseSemver(v) ? v : null;
  if (Array.isArray(v)) {
    let newest: string | null = null;
    for (const e of v) {
      if (
        typeof e === 'string' &&
        parseSemver(e) &&
        (newest === null || compareVersions(e, newest) > 0)
      )
        newest = e;
    }
    return newest;
  }
  return null;
}

// ---------- outcome persistence (settings kv) ----------

/** A stored outcome, or null for a missing — or corrupt — row (a corrupt
 *  row reads as "never": it is data we wrote, not a db failure). */
function parseJsonSetting<T>(raw: string | null): T | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return v && typeof v === 'object' ? (v as T) : null;
}

/** An unreadable db is a database_error — never read as "never". */
function readJsonSetting<T>(db: StateDb, key: string) {
  return databaseRead(`could not read ${key}`, () => parseJsonSetting<T>(db.getSetting(key)));
}

/** Persist an outcome. Best-effort by design: a background check has no
 *  caller to report to, so a failed write is logged and the next check
 *  writes again. */
function writeJsonSetting(db: StateDb, key: string, value: unknown): void {
  const saved = databaseUpdate(`pi auto-update: could not persist ${key}`, () =>
    db.setSetting(key, JSON.stringify(value)),
  );
  if (!saved.ok) log.error(saved.errorMessage ?? key);
}

/** Read the persisted toggle (database_read: value true/false). Default
 *  OFF — a missing row is OFF; an unreadable db is a database_error, not
 *  OFF. */
export function autoUpdateEnabled(db: StateDb) {
  return databaseRead(
    'could not read the auto-update setting',
    () => db.getSetting(KEY_ENABLED) === '1',
  );
}

export function setAutoUpdateEnabled(db: StateDb, on: boolean) {
  return databaseUpdate('could not save the setting', () =>
    db.setSetting(KEY_ENABLED, on ? '1' : '0'),
  );
}

export function lastCheck(db: StateDb) {
  return readJsonSetting<AutoUpdateCheck>(db, KEY_LAST_CHECK);
}

export function lastUpdate(db: StateDb) {
  return readJsonSetting<AutoUpdateResult>(db, KEY_LAST_UPDATE);
}

function saveCheck(db: StateDb, outcome: AutoUpdateCheck['outcome'], detail: string): void {
  writeJsonSetting(db, KEY_LAST_CHECK, {
    at: Date.now(),
    outcome,
    detail,
  } satisfies AutoUpdateCheck);
}

// ---------- the check itself ----------

export interface CheckDeps {
  db: StateDb;
  appRoot: string;
}

/** One check: query the registry for the newest pi within the declared
 *  range, install it through runPiUpdate when it is newer than the
 *  installed one, and persist the outcome either way. Never throws —
 *  failures are recorded as outcomes. */
export async function performAutoUpdateCheck(deps: CheckDeps): Promise<void> {
  const { db, appRoot } = deps;
  const fail = (detail: string): void => saveCheck(db, 'failed', detail);

  const declared = piDeclared(appRoot);
  const spec = autoUpdateSpec(declared);
  if (!spec)
    return fail(`declared range "${declared}" cannot drive auto-update — leaving pi alone`);
  const npm = npmPath();
  if (!npm) return fail('npm was not found on the server PATH — cannot check');

  // Registry query only — nothing is installed by `npm view`.
  const latest = await new Promise<string | null>(resolve =>
    execFile(
      npm,
      ['view', spec, 'version', '--json'],
      { timeout: VIEW_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err || !stdout ? null : parseNpmViewVersion(stdout)),
    ),
  );
  if (!latest)
    return fail(`could not determine the newest pi within ${declared} (npm view failed)`);

  const installed = piInstalled(appRoot);
  if (!shouldAutoUpdate(installed, latest)) {
    // No install happens for exactly three reasons — the installed pi IS
    // the newest in range, it sits ABOVE the range (manual @latest — never
    // downgraded back into range), or it doesn't compare at all (never
    // touch what can't be reasoned about). The status line says which.
    const detail = !isPlainVersion(installed as string)
      ? `installed pi "${installed}" does not compare as a version — left alone`
      : compareVersions(installed as string, latest) > 0
        ? `pi ${installed} is above the declared range ${declared} — left alone`
        : `pi ${installed} is the newest within ${declared}`;
    return saveCheck(db, 'up-to-date', detail);
  }

  // FLEET JUNCTION (task/privilege-split): in the two-container shape pi's
  // node_modules moves to the workspace container, so this install (and the
  // registry probe above) become workspace-side operations. The decision
  // logic (range, compare, outcomes) stays web-side; a split-aware delegate
  // replaces exactly this runPiUpdate call — e.g. forward the spec to the
  // workspace container and relay its PiUpdateResult back. Not implemented:
  // single-process today; see also the sibling note in settings.ts.
  log.info(
    `pi auto-update: ${latest} is newer than ${installed ?? 'nothing'} — installing within ${declared}`,
  );
  const r = await runPiUpdate(appRoot, false, spec);
  writeJsonSetting(db, KEY_LAST_UPDATE, {
    at: Date.now(),
    ok: r.ok,
    before: r.data.before,
    after: r.data.after,
    detail: r.ok
      ? `pi ${r.data.before ?? 'not installed'} → ${r.data.after ?? 'not installed'} (within ${declared})`
      : r.errorMessage,
    output: r.data.output.slice(-OUTPUT_CAP),
  } satisfies AutoUpdateResult);
  saveCheck(
    db,
    r.ok ? 'installed' : 'failed',
    r.ok
      ? `installed pi ${r.data.after ?? '?'} (within ${declared})`
      : `install of ${latest} failed: ${r.errorMessage}`,
  );
}

// ---------- the periodic wiring ----------

export interface AutoUpdaterDeps {
  db: StateDb;
  appRoot: string;
  /** delay before the first check after boot / after the toggle is turned
   *  ON. Default 60s, also on purpose for the e2e suite: the settings test
   *  toggles the setting ON through the UI near the end of the run, and
   *  the suite (webServer teardown included) finishes well inside a
   *  minute — so the e2e server never reaches a real npm invocation. */
  firstDelayMs?: number;
  /** default 24h */
  intervalMs?: number;
  /** replaces the whole check flow (tests stub this, never real npm) */
  check?: () => Promise<void>;
}

/** Owns the auto-update timing: with the setting ON, one check shortly
 *  after boot (or after the toggle is turned ON) and then every 24h.
 *  OFF means no npm runs, full stop — the boot probe reads the setting
 *  lazily (never at construction: the state db opens lazily by design,
 *  and the e2e webServer boots before global-setup resets its workspace). */
export class AutoUpdater {
  private probe: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private readonly firstDelayMs: number;
  private readonly intervalMs: number;

  constructor(private deps: AutoUpdaterDeps) {
    this.firstDelayMs = deps.firstDelayMs ?? FIRST_CHECK_DELAY_MS;
    this.intervalMs = deps.intervalMs ?? CHECK_INTERVAL_MS;
  }

  private get check(): () => Promise<void> {
    const { check, db, appRoot } = this.deps;
    return check ?? ((): Promise<void> => performAutoUpdateCheck({ db, appRoot }));
  }

  /** Arm the boot probe: FIRST_CHECK_DELAY_MS after start, read the
   *  persisted setting; when ON, run the first check and arm the 24h
   *  interval. Calling this on an OFF server is inert apart from that one
   *  deferred point query — nothing npm-shaped is ever scheduled by an
   *  OFF setting. */
  start(): void {
    this.armProbe();
  }

  stop(): void {
    if (this.probe) {
      clearTimeout(this.probe);
      this.probe = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The toggle endpoint: persist, then rewire. ON arms the probe (a
   *  first check within firstDelayMs); OFF stops everything. A failed
   *  save leaves the timers as they were. */
  setEnabled(on: boolean) {
    const saved = setAutoUpdateEnabled(this.deps.db, on);
    if (!saved.ok) return saved;
    this.stop();
    if (on) this.armProbe();
    return saved;
  }

  private armProbe(): void {
    if (this.probe || this.timer) return; // already armed
    this.probe = setTimeout(() => {
      this.probe = null;
      const enabled = autoUpdateEnabled(this.deps.db);
      if (!enabled.ok) {
        // Unreadable setting: neither ON nor OFF is known, and npm never
        // runs on a guess — look again after another delay.
        log.error(`pi auto-update: ${enabled.errorMessage} — retrying`);
        this.armProbe();
        return;
      }
      if (!enabled.data.value) return;
      this.timer = setInterval(() => {
        void this.runCheck();
      }, this.intervalMs);
      void this.runCheck();
    }, this.firstDelayMs);
  }

  /** One check, guarded against overlap (a slow install must not stack
   *  with the next fire) and against throwing into a timer (a failed
   *  check must never take the server down). */
  private async runCheck(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.check();
    } catch (err) {
      log.error(`pi auto-update check failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.checking = false;
    }
  }
}
