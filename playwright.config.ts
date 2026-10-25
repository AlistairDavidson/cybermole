import { defineConfig, devices } from '@playwright/test';
import {
  S3_ACCESS_KEY,
  S3_BUCKET,
  S3_PORT,
  TMUX_SOCKET,
  WORKSPACE,
  STATE_DIR,
  APPS_ROOT,
} from './tests/support/env';

const PORT = 3470;

export default defineConfig({
  testDir: './tests/e2e',
  // Only the specs: Playwright's default pattern would also import the node:test units.
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
  globalSetup: './tests/support/global-setup.ts',
  webServer: [
    {
      // In-memory S3 for POST /api/files (only what src/lib/platform/storage.ts calls).
      command: `node tests/support/fake-s3.mjs ${S3_PORT} ${S3_ACCESS_KEY}`,
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
        // A sibling of WORKSPACE: with CYBERMOLE_APPS_SOCK unset the server
        // spawns the app host at <STATE_DIR>/apps.sock, and global-setup
        // rm -rf's WORKSPACE after boot. The db and agent dir are pointed
        // into WORKSPACE explicitly.
        CYBERMOLE_STATE_DIR: STATE_DIR,
        // The server's own apps-root opinion (the /api/apps/status join):
        // the suite's run-scoped root, so unregistered trees are per-run too.
        CYBERMOLE_APPS_ROOT: APPS_ROOT,
        // Serial from one IP, the suite upgrades far more than 30/min.
        CYBERMOLE_WS_UPGRADES_PER_MIN: '300',
        CYBERMOLE_DB_FILE: `${WORKSPACE}/cybermole.db`,
        CYBERMOLE_AGENT_DIR: `${WORKSPACE}/pi-agent`,
        CYBERMOLE_NEW_SESSION_CWD: WORKSPACE,
        CYBERMOLE_TMUX_SOCKET: TMUX_SOCKET,
        CYBERMOLE_COMMAND: `${WORKSPACE}/cmd.sh`,
        // The `agent` argument marks the auto-opened tab's banner.
        CYBERMOLE_AGENT_COMMAND: `${WORKSPACE}/cmd.sh agent`,
        CYBERMOLE_JOB_LOG_DIR: `${WORKSPACE}/job-logs`,
        // Outside WORKSPACE, like the state dir: the listener is created eagerly.
        CYBERMOLE_SOCK: `${WORKSPACE}.sock`,
        CYBERMOLE_S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`,
        CYBERMOLE_S3_ACCESS_KEY: S3_ACCESS_KEY,
        CYBERMOLE_S3_SECRET_KEY: 'itest-secret',
        CYBERMOLE_S3_BUCKET: S3_BUCKET,
      },
    },
  ],
});
