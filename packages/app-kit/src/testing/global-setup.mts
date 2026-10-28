// The kit's default e2e global setup: (a) fail loud and clean when
// Playwright's chromium is missing — app trees often run where no browser
// is installed — and (b) build the app when dist/ is missing (the console's
// global-setup pattern). Runs through `npm run test:e2e` in the app tree,
// so process.cwd() locates the app.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from '@playwright/test';
import { appRootFrom } from './app-tree.mjs';

export default async function globalSetup(): Promise<void> {
  await requireBrowser();
  const appRoot = appRootFrom(process.cwd());
  if (!fs.existsSync(path.join(appRoot, 'dist', 'server', 'entry.mjs')))
    execFileSync('npm', ['run', 'build'], { cwd: appRoot, stdio: 'inherit' });
}

/** A real launch, not an executablePath() probe: the only check that
 *  matches what the tests do, and the only error worth reading. */
async function requireBrowser(): Promise<void> {
  try {
    const browser = await chromium.launch();
    await browser.close();
  } catch (err) {
    const reason = (err as Error).message.split('\n').slice(0, 2).join('\n');
    throw new Error(
      [
        'Playwright chromium is not available to this tree — the app e2e',
        'suite needs a real browser.',
        '',
        `  ${reason.replaceAll('\n', '\n  ')}`,
        '',
        'Fix:',
        '  - dev host / networked machine: cd <the app tree> && npx playwright install chromium',
        '  - fleet sandbox: the browser cache mounts read-only from the host —',
        '    run `npx playwright install chromium` ON THE HOST once, then re-run.',
        '',
        'No browser, no e2e: `npm run test` (unit) and `npm run build` still cover',
        'everything else.',
      ].join('\n'),
    );
  }
}
