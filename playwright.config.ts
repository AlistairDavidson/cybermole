import { defineConfig, devices } from '@playwright/test';
import { S3_ACCESS_KEY, S3_BUCKET, S3_PORT, TMUX_SOCKET, WORKSPACE } from './tests/env';

const PORT = 3470;

export default defineConfig({
  testDir: './tests',
  // Only the Playwright specs (e2e / state-dir / restart …): the
  // node:test units under tests/unit/ are `npm run test:unit` territory,
  // and Playwright's default pattern (*.@(spec|test).(c|m)…js) would import
  // them as specs and run their tests inline mid-suite.
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  // Serial: tests share one login rate-limit budget (per-IP, in-memory)
  // and one tmux test socket.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './tests/global-setup.ts',
  webServer: [
    {
      // In-memory S3 for POST /api/files (only what src/lib/storage.ts calls).
      command: `node tests/fake-s3.mjs ${S3_PORT} ${S3_ACCESS_KEY}`,
      url: `http://127.0.0.1:${S3_PORT}/__fake/health`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node dist-server/server/main.js',
      url: `http://127.0.0.1:${PORT}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        CYBERMOLE_PORT: String(PORT),
        CYBERMOLE_HOST: '127.0.0.1',
        // The suite is serial from one IP and legitimately upgrades far more
        // than a human (every terminal test attaches/pops/reconnects) — the
        // production default of 30/min refuses the jobs test's run attach.
        CYBERMOLE_WS_UPGRADES_PER_MIN: '300',
        CYBERMOLE_DB_FILE: `${WORKSPACE}/cybermole.db`,
        CYBERMOLE_AGENT_DIR: `${WORKSPACE}/pi-agent`,
        CYBERMOLE_NEW_SESSION_CWD: WORKSPACE,
        CYBERMOLE_TMUX_SOCKET: TMUX_SOCKET,
        CYBERMOLE_COMMAND: `${WORKSPACE}/cmd.sh`,
        // task/defaults-settings: the auto-opened first terminal of a new
        // workspace — the same deterministic cmd.sh, with the marker
        // argument that distinguishes its banner from a plain tab's.
        CYBERMOLE_AGENT_COMMAND: `${WORKSPACE}/cmd.sh agent`,
        CYBERMOLE_JOB_LOG_DIR: `${WORKSPACE}/job-logs`,
        // The internal jobs socket (jobs-agent-plan §3) — OUTSIDE WORKSPACE:
        // global-setup rm -rf's WORKSPACE AFTER this server boots, and the
        // listener is created eagerly (unlike the db / tmux, opened lazily).
        // A sibling file; SIGTERM unlinks it, the stale-probe covers crashes.
        CYBERMOLE_SOCK: `${WORKSPACE}.sock`,
        CYBERMOLE_S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
        CYBERMOLE_S3_ACCESS_KEY: S3_ACCESS_KEY,
        CYBERMOLE_S3_SECRET_KEY: 'itest-secret',
        CYBERMOLE_S3_BUCKET: S3_BUCKET,
      },
    },
  ],
});
