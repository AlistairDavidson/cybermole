// Shared constants for the e2e suite (also used by global-setup and the
// playwright.config webServer env).
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
export const USERNAME = 'tester';
export const PASSWORD = 'correct-horse-9';
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
