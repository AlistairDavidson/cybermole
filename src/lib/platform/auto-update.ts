// The 'auto-update pi' setting (default off): checks daily for a newer pi
// within the range package.json declares and installs it via runPiUpdate.
// Unlike the manual button (@latest), it stays within the range, and leaves
// alone a pi installed above it (never downgrades).
import { execFile } from 'node:child_process';
import type { StateDb } from './db';
import { databaseRead, databaseUpdate } from '@cybermole/app-kit';
import { componentLogger } from './logger';
import type { AutoUpdateCheck, AutoUpdateResult } from './types';
import { PI_PACKAGE, npmPath, piDeclared, piInstalled, runPiUpdate } from './settings';

const log = componentLogger('update');

const KEY_ENABLED = 'piAutoUpdate.enabled';
const KEY_LAST_CHECK = 'piAutoUpdate.lastCheck';
const KEY_LAST_UPDATE = 'piAutoUpdate.lastUpdate';

export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VIEW_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 16 * 1024;

// ---------- decision logic ----------

/** Deliberately narrow: URLs, git refs and dist-tags disable auto-update rather than be guessed at. */
const RANGE_RE = /^[\d.^~*<>=|\sxX-]+$/;

/** null when the declared value can't be a range (recorded as a failed check). */
export function autoUpdateSpec(declared: string): string | null {
  const d = declared.trim();
  if (!d || !RANGE_RE.test(d)) return null;
  return `${PI_PACKAGE}@${d}`;
}

/** Build metadata is ignored, per semver precedence. */
function parseSemver(v: string): [number, number, number, string[]] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? [] : m[4].split('.')];
}

export function isPlainVersion(v: string): boolean {
  return parseSemver(v) !== null;
}

/** 0 when either side is unparseable, so the caller never installs. */
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

/** Not installed counts as outdated; an unparseable installed version never does. */
export function shouldAutoUpdate(installed: string | null, latestInRange: string): boolean {
  return installed === null || compareVersions(latestInRange, installed) > 0;
}

/** npm answers a range with every match (or a bare string for one); take
 *  the max by precedence, not list order. */
export function parseNpmViewVersion(out: string): string | null {
  const t = out.trim();
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    v = t;
  }
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

// ---------- outcome persistence ----------

/** A corrupt row reads as "never": it's our own data, not a db failure. */
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

/** An unreadable db is database_error, never "never". */
function readJsonSetting<T>(db: StateDb, key: string) {
  return databaseRead(`could not read ${key}`, () => parseJsonSetting<T>(db.getSetting(key)));
}

/** Best-effort: a background check has nobody to report to. */
function writeJsonSetting(db: StateDb, key: string, value: unknown): void {
  const saved = databaseUpdate(`pi auto-update: could not persist ${key}`, () =>
    db.setSetting(key, JSON.stringify(value)),
  );
  if (!saved.ok) log.error(saved.errorMessage ?? key);
}

/** A missing row is off; an unreadable db is database_error, not off. */
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

// ---------- check ----------

export interface CheckDeps {
  db: StateDb;
  appRoot: string;
}

/** Never throws; failures are recorded as outcomes. */
export async function performAutoUpdateCheck(deps: CheckDeps): Promise<void> {
  const { db, appRoot } = deps;
  const fail = (detail: string): void => saveCheck(db, 'failed', detail);

  const declared = piDeclared(appRoot);
  const spec = autoUpdateSpec(declared);
  if (!spec)
    return fail(`declared range "${declared}" cannot drive auto-update — leaving pi alone`);
  const npm = npmPath();
  if (!npm) return fail('npm was not found on the server PATH — cannot check');

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
    // Newest in range, above the range, or not comparable; say which.
    const detail = !isPlainVersion(installed as string)
      ? `installed pi "${installed}" does not compare as a version — left alone`
      : compareVersions(installed as string, latest) > 0
        ? `pi ${installed} is above the declared range ${declared} — left alone`
        : `pi ${installed} is the newest within ${declared}`;
    return saveCheck(db, 'up-to-date', detail);
  }

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

// ---------- scheduling ----------

export interface AutoUpdaterDeps {
  db: StateDb;
  appRoot: string;
  /** Default 60 s, which also keeps the e2e suite (it toggles this on near
   *  the end) from ever reaching a real npm run. */
  firstDelayMs?: number;
  intervalMs?: number;
  /** tests stub this */
  check?: () => Promise<void>;
}

/** Off means npm never runs. The setting is read lazily, never at
 *  construction, since the state db opens lazily. */
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

  /** A failed save leaves the timers as they were. */
  setEnabled(on: boolean) {
    const saved = setAutoUpdateEnabled(this.deps.db, on);
    if (!saved.ok) return saved;
    this.stop();
    if (on) this.armProbe();
    return saved;
  }

  private armProbe(): void {
    if (this.probe || this.timer) return;
    this.probe = setTimeout(() => {
      this.probe = null;
      const enabled = autoUpdateEnabled(this.deps.db);
      if (!enabled.ok) {
        // Neither on nor off is known; never run npm on a guess.
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

  /** Guards against overlapping checks and against throwing into a timer. */
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
