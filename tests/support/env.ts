// Shared constants for the e2e suite, global-setup and the webServer env.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const WORKSPACE = '/tmp/cybermole-itest';
// A sibling of WORKSPACE (global-setup rm -rf's that after boot, while the
// app host's socket is created eagerly). CYBERMOLE_APPS_SOCK stays unset so
// the server spawns the host itself, and e2e covers that spawn rule.
export const STATE_DIR = '/tmp/cybermole-itest-state';
/** Computed with the server's own rule, never hard-coded. */
export const APPS_SOCKET = '/tmp/cybermole-itest-state/apps.sock';
export const INTERNAL_SOCKET = `${WORKSPACE}.sock`;
// Under WORKSPACE, so the per-run reset clears it.
export const APPS_ROOT = `${WORKSPACE}/apps`;
export const USERNAME = 'tester';
export const PASSWORD = 'correct-horse-9';

// The apps specs share one session cookie through this file: each spec's
// own sign-in pushed the run over the 10/15-min login budget. Under
// WORKSPACE, so it's run-scoped. e2e.spec keeps its own sign-in, since its
// logout tests invalidate cookies.
export function readSharedSessionCookie(): string | null {
  try {
    const v = fs.readFileSync(SHARED_COOKIE_FILE, 'utf8').trim();
    return v === '' ? null : v;
  } catch {
    return null;
  }
}

export function writeSharedSessionCookie(header: string): void {
  try {
    fs.mkdirSync(path.dirname(SHARED_COOKIE_FILE), { recursive: true });
    fs.writeFileSync(SHARED_COOKIE_FILE, header);
  } catch {
    /* best-effort: costs the next file a sign-in */
  }
}
const SHARED_COOKIE_FILE = path.join(WORKSPACE, '.apps-session-cookie');

export const TMUX_SOCKET = 'cybermole-itest';
export const MARKER = 'ITEST_MARKER_READY';
// The auto-opened agent tab's banner marker, distinct from MARKER.
export const AGENT_MARKER = 'ITEST_AGENT_MARKER';
// Started by the webServer list ahead of the app.
export const S3_PORT = 3490; // clear of the specs' own server ports (3470–3484)
export const S3_BUCKET = 'cybermole-itest';
export const S3_ACCESS_KEY = 'itest-access';
