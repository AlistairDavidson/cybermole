// The shared half of an app's playwright.config.ts: serial, list reporter,
// chromium, and the kit's global setup (browser preflight + build-if-
// missing). Tests carry no baked paths — createAppTest(import.meta.url)
// locates the tree — so this factory needs no appRoot.
import { devices, type Config } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export interface AppPlaywrightConfigOptions {
  /** Default './tests/e2e'. */
  testDir?: string;
  /** Default 30_000. */
  timeout?: number;
}

export function appPlaywrightConfig(options: AppPlaywrightConfigOptions = {}): Config {
  return {
    // Only the specs: the default pattern would also pick up unit tests.
    testDir: options.testDir ?? './tests/e2e',
    testMatch: '**/*.spec.ts',
    timeout: options.timeout ?? 30_000,
    // Serial and cheap: the app fixture is worker-scoped, so one worker is
    // one boot and one hermetic dir per run.
    workers: 1,
    fullyParallel: false,
    retries: 0,
    reporter: 'list',
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    globalSetup: fileURLToPath(new URL('./global-setup.mts', import.meta.url)),
  };
}
