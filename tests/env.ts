// Shared constants for the e2e suite (also used by global-setup and the
// playwright.config webServer env).
import * as fs from 'node:fs';
import * as path from 'node:path';

export const WORKSPACE = '/tmp/cybermole-itest';
// task/app-web: the webServer's CYBERMOLE_STATE_DIR — a SIBLING of
// WORKSPACE (global-setup rm -rf's WORKSPACE after the server boots,
// and the app host's default socket <state dir>/apps.sock is created
// eagerly at boot by the spawn rule below). The suite leaves
// CYBERMOLE_APPS_SOCK UNSET on purpose: the web server then spawns +
// supervises the host itself (the single-user shape, apps-plan §3) —
// e2e covers the spawn rule, not just the client side of it.
export const STATE_DIR = '/tmp/cybermole-itest-state';
/** The app host's socket in the e2e shape: the SAME default the web
 *  server resolves (env.ts appsSocketDefault over the sibling state dir
 *  — computed here so the specs never hard-code a path the env rules
 *  own). */
export const APPS_SOCKET = '/tmp/cybermole-itest-state/apps.sock';
/** The webServer's internal API socket (playwright.config CYBERMOLE_SOCK)
 *  — the specs' registration/reload pokes ride it and the apps socket. */
export const INTERNAL_SOCKET = `${WORKSPACE}.sock`;
// task/app-scaffold: the apps root the in-process MCP verbs scaffold into
// (under WORKSPACE so global-setup's reset owns it between runs; the
// webServer needs no CYBERMOLE_APPS_ROOT — the MCP's deps carry this).
export const APPS_ROOT = `${WORKSPACE}/apps`;
export const USERNAME = 'tester';
export const PASSWORD = 'correct-horse-9';

// task/app-actions (integration): the suite's per-IP login budget is
// 10 attempts / 15 min and EVERY spec file that needs a browser signs
// in once through its own login() helper. The three apps specs pushed
// the count over (the post-logout re-logins late in e2e.spec started
// eating 429s — timed out at the sign-in form), so the apps specs share
// ONE session cookie through this file instead: the first apps file to
// sign in writes it, the others reuse it. The file lives under WORKSPACE
// (global-setup rm -rf's it per run, so it is run-scoped — never stale
// across runs). e2e.spec deliberately stays on its own isolated sign-in:
// its logout tests invalidate cookies, and its usage was already inside
// the budget before the apps specs existed.
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
    /* best-effort — a failed write just costs the next file a sign-in */
  }
}
const SHARED_COOKIE_FILE = path.join(WORKSPACE, '.apps-session-cookie');

export const TMUX_SOCKET = 'cybermole-itest';
export const MARKER = 'ITEST_MARKER_READY';
// task/defaults-settings: the auto-opened first terminal of a new
// workspace runs CYBERMOLE_AGENT_COMMAND — the same deterministic cmd.sh
// with a distinct marker argument, so a test can tell the agent tab's
// output from a plain tab's (which keeps MARKER via CYBERMOLE_COMMAND).
export const AGENT_MARKER = 'ITEST_AGENT_MARKER';
// Object storage for the run: tests/fake-s3.mjs, started by the
// playwright.config webServer list ahead of the app.
export const S3_PORT = 3490; // clear of the specs' own server ports (3470–3484)
export const S3_BUCKET = 'cybermole-itest';
export const S3_ACCESS_KEY = 'itest-access';
