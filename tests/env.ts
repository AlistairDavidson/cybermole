// Shared constants for the e2e suite (also used by global-setup and the
// playwright.config webServer env).
export const WORKSPACE = '/tmp/web-pi-itest';
export const USERNAME = 'tester';
export const PASSWORD = 'correct-horse-9';
export const TMUX_SOCKET = 'web-pi-itest';
export const MARKER = 'ITEST_MARKER_READY';
// Two pi sessions whose UUIDv7 ids share their first 8 hex chars (created
// within the same ~65 s) — resume must keep them apart.
export const UUIDV7_SIBLINGS = [
  '019f4706-0000-7000-8000-000000000001',
  '019f4706-0000-7000-8000-000000000002',
] as const;
// Object storage for the run: tests/fake-s3.mjs, started by the
// playwright.config webServer list ahead of the app.
export const S3_PORT = 3490; // clear of the specs' own server ports (3470–3483)
export const S3_BUCKET = 'webpi-itest';
export const S3_ACCESS_KEY = 'itest-access';
