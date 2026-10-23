// Shared constants for the e2e suite (also used by global-setup and the
// playwright.config webServer env).
export const WORKSPACE = '/tmp/cybermole-itest';
export const USERNAME = 'tester';
export const PASSWORD = 'correct-horse-9';
export const TMUX_SOCKET = 'cybermole-itest';
export const MARKER = 'ITEST_MARKER_READY';
// Object storage for the run: tests/fake-s3.mjs, started by the
// playwright.config webServer list ahead of the app.
export const S3_PORT = 3490; // clear of the specs' own server ports (3470–3484)
export const S3_BUCKET = 'cybermole-itest';
export const S3_ACCESS_KEY = 'itest-access';
