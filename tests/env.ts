// Shared constants for the e2e suite (also used by global-setup and the
// playwright.config webServer env).
export const WORKSPACE = '/tmp/cybermole-itest';
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
