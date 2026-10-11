// zed.ts — open a folder in the Zed webapp (docs/zed-webapp.md). The
// console's "open in Zed" affordances POST /api/zed/open, which calls
// openInZed: a POST to the launcher inside the zed container over the
// compose network (the web container has no docker socket by design),
// which runs `zed <path>` as the workspace uid — the running instance
// opens it over its CLI socket, or the CLI boots Zed with it.
import * as fs from 'node:fs';
import type { ResultFailure, ResultSuccess } from '../types/result';

/** What readZedConfig (env.ts) builds from WEB_PI_ZED_URL /
 *  WEB_PI_ZED_LAUNCH_URL / WEB_PI_ZED_LAUNCH_TOKEN — all three or none. */
export interface ZedLaunchConfig {
  /** browser-facing stream URL, e.g. https://zed.example.com */
  url: string;
  /** the launcher endpoint inside the zed container, e.g. http://zed:7999/open */
  launchUrl: string;
  /** shared secret the launcher expects as `Authorization: Bearer …` */
  token: string;
}

export type ZedOpenData = { path: string };
export type ZedOpenErrorCode =
  | 'zed_not_configured'   // no WEB_PI_ZED_* config — the UI hides the affordances
  | 'invalid_path'         // not absolute, or not a directory the web side can see
  | 'launcher_unreachable' // no answer from the zed container (profile not up?)
  | 'launch_failed';       // answered, but refused (bad token, its own checks failed)
export type ZedOpenSuccess = ResultSuccess<'zed_open', ZedOpenData>;
export type ZedOpenFailure = ResultFailure<'zed_open', ZedOpenData, ZedOpenErrorCode>;
export type ZedOpenResult = ZedOpenSuccess | ZedOpenFailure;

function fail(path: string, errorCode: ZedOpenErrorCode, errorMessage: string) {
  return { ok: false, resultType: 'zed_open', data: { path }, errorCode, errorMessage } satisfies ZedOpenFailure;
}

/** Open `path` as a workspace window in the Zed webapp. Validation here
 *  (absolute + a directory the web side can stat) is about typos, not
 *  access control: the caller already holds the session cookie, which is
 *  a shell as the sessions' user — any directory it can name is not a
 *  new privilege. The launcher re-validates under /workspace before it
 *  spawns anything. */
export async function openInZed(cfg: ZedLaunchConfig | null, path: string): Promise<ZedOpenResult> {
  if (!cfg) return fail(path, 'zed_not_configured', 'the Zed webapp is not configured (WEB_PI_ZED_URL)');
  if (!path.startsWith('/')) return fail(path, 'invalid_path', 'path must be absolute');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch {
    return fail(path, 'invalid_path', `no such directory: ${path}`);
  }
  if (!stat.isDirectory()) return fail(path, 'invalid_path', `not a directory: ${path}`);

  let response: Response;
  try {
    response = await fetch(cfg.launchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.token}` },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return fail(path, 'launcher_unreachable', `could not reach the Zed launcher: ${(e as Error).message}`);
  }
  if (response.status === 400) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    return fail(path, 'invalid_path', body?.error ?? 'the launcher rejected the path');
  }
  if (!response.ok) {
    return fail(path, 'launch_failed', `the launcher answered ${response.status}`);
  }
  return { ok: true, resultType: 'zed_open', data: { path } } satisfies ZedOpenSuccess;
}
