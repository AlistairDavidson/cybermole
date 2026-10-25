// Version facts for /settings and the manual pi updater. No restart needed:
// sessions exec the vendored node_modules/.bin/pi fresh, so new sessions get
// the new version.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { componentLogger } from './logger';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

const log = componentLogger('update');

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000; // npm can be slow; one try, no retry
const OUTPUT_CAP = 64 * 1024; // keep the tail for the UI

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appVersion(appRoot: string): string {
  const pkg = readJson(path.join(appRoot, 'package.json'));
  const v = pkg?.version;
  return typeof v === 'string' ? v : 'unknown';
}

export function piDeclared(appRoot: string): string {
  const pkg = readJson(path.join(appRoot, 'package.json'));
  const deps = pkg?.dependencies;
  const range =
    deps && typeof deps === 'object' ? (deps as Record<string, unknown>)[PI_PACKAGE] : undefined;
  return typeof range === 'string' ? range : 'unknown';
}

export function piInstalled(appRoot: string): string | null {
  const pkg = readJson(path.join(appRoot, 'node_modules', PI_PACKAGE, 'package.json'));
  const v = pkg?.version;
  return typeof v === 'string' ? v : null;
}

/** null hides the update button. */
export function npmPath(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'npm');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// npm locks node_modules, so one update at a time (a second gets 409).
let updateBusy = false;

export type PiUpdateData = {
  dryRun: boolean;
  command: string;
  /** null: not installed */
  before: string | null;
  after: string | null;
  /** dry-run: the check output; capped */
  output: string;
};
/** npm_check_failed: the dry-run's `npm --version` failed. */
export type PiUpdateErrorCode = 'busy' | 'npm_missing' | 'npm_check_failed' | 'npm_failed';
export type PiUpdateSuccess = ResultSuccess<'pi_update', PiUpdateData>;
export type PiUpdateFailure = ResultFailure<'pi_update', PiUpdateData, PiUpdateErrorCode>;
export type PiUpdateResult = PiUpdateSuccess | PiUpdateFailure;

/** Never rejects. The button installs @latest; the auto-updater passes the
 *  declared range instead, sharing the busy guard. */
export async function runPiUpdate(
  appRoot: string,
  dryRun: boolean,
  spec: string = `${PI_PACKAGE}@latest`,
) {
  const args = ['install', spec];
  const command = `npm ${args.join(' ')}`;
  const before = piInstalled(appRoot);
  const data = (extra: Partial<PiUpdateData> = {}): PiUpdateData => ({
    dryRun,
    command,
    before,
    after: before,
    output: '',
    ...extra,
  });
  const fail = (
    errorCode: PiUpdateErrorCode,
    errorMessage: string,
    extra: Partial<PiUpdateData> = {},
  ) =>
    ({
      ok: false,
      resultType: 'pi_update',
      data: data(extra),
      errorCode,
      errorMessage,
    }) satisfies PiUpdateFailure;
  const npmMissing = 'npm was not found on the server PATH — cannot update from here';

  if (dryRun) {
    // Touches nothing, so it isn't blocked by a running update.
    const npm = npmPath();
    if (!npm) return fail('npm_missing', npmMissing);
    const checked = await new Promise<{ err: Error | null; stdout: string }>(resolve =>
      execFile(npm, ['--version'], { timeout: 15_000 }, (err, stdout) =>
        resolve({ err, stdout: String(stdout) }),
      ),
    );
    if (checked.err) return fail('npm_check_failed', `npm check failed: ${checked.err.message}`);
    return {
      ok: true,
      resultType: 'pi_update',
      data: data({
        output: `would run \`${command}\` in ${appRoot} (npm ${checked.stdout.trim()} is available)`,
      }),
    } satisfies PiUpdateSuccess;
  }

  if (updateBusy) return fail('busy', 'an update is already running');
  const npm = npmPath();
  if (!npm) return fail('npm_missing', npmMissing);

  updateBusy = true;
  log.info(`pi update: running \`${command}\` in ${appRoot}`);
  const installed = await new Promise<{
    err: (Error & { killed?: boolean; code?: unknown }) | null;
    out: string;
  }>(resolve =>
    execFile(
      npm,
      args,
      { cwd: appRoot, timeout: UPDATE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, out: `${stdout}${stderr ? '\n' + stderr : ''}` }),
    ),
  );
  updateBusy = false;
  const after = piInstalled(appRoot);
  const output = installed.out.trim().slice(-OUTPUT_CAP);
  if (installed.err) {
    const reason = installed.err.killed
      ? `timed out after ${Math.round(UPDATE_TIMEOUT_MS / 60000)} minutes`
      : `npm exited with code ${String(installed.err.code ?? '?')}`;
    log.warn(`pi update failed: ${reason}`);
    return fail('npm_failed', reason, { after, output });
  }
  log.info(
    `pi update: ${before ?? 'not installed'} → ${after ?? 'not installed'} ` +
      `(new sessions use it)`,
  );
  return {
    ok: true,
    resultType: 'pi_update',
    data: data({ after, output }),
  } satisfies PiUpdateSuccess;
}
