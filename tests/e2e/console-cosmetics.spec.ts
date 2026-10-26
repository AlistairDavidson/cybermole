// Console cosmetics: the cybermole product label (title, nav, sidebar
// heading), the page-entry fade (and its reduced-motion skip), the
// desktop nav collapse (persisted, rail with the expand control), and the
// new-app dialog's directory suggestion from the name.
//
// Apps-spec discipline: one login() via the shared cookie file (env.ts); no
// afterAll; each test starts from a fresh context (localStorage included),
// so the collapse tests cannot leak state into other specs.
import { expect, test } from '@playwright/test';
import type { Cookie, Page } from '@playwright/test';
import {
  PASSWORD,
  USERNAME,
  WORKSPACE,
  readSharedSessionCookie,
  writeSharedSessionCookie,
} from '../support/env';

// ---------- shared helpers (the apps-spec shape) ----------

let sessionCookie: Cookie | null = null;
async function login(page: Page): Promise<void> {
  if (!sessionCookie) {
    const shared = readSharedSessionCookie();
    if (shared !== null) {
      const [name, ...rest] = shared.split('=');
      sessionCookie = {
        name,
        value: rest.join('='),
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Strict',
        expires: -1,
      };
    }
  }
  if (sessionCookie) {
    await page.context().addCookies([sessionCookie]);
    await page.goto('/');
  } else {
    await page.goto('/login');
    await page.fill('wa-input#username input', USERNAME);
    await page.fill('wa-input#password input', PASSWORD);
    await page.click('wa-button:has-text("sign in")');
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie =
      (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
    if (sessionCookie) writeSharedSessionCookie(`${sessionCookie.name}=${sessionCookie.value}`);
    await page.goto('/');
  }
  await page.waitForSelector('workspace-sidebar .nav');
}

/** The console-app host's computed animation-name (persists after the run). */
function pageEnterAnimation(page: Page): Promise<string> {
  return page.evaluate(
    () => getComputedStyle(document.querySelector('console-app')!).animationName,
  );
}

// ---------- the product label ----------

test('the product shows as cybermole: page title, nav brand, sidebar group heading', async ({
  page,
}) => {
  await login(page);
  await expect(page).toHaveTitle('cybermole');
  // The header's brand link (icon button; the label rides its title).
  await expect(page.locator('app-header wa-button.app-brand')).toHaveAttribute(
    'title',
    'Cybermole',
  );
  // The / page's single group names the product, not "console".
  const heading = page.locator('workspace-sidebar .ws-group h2 .g-name');
  await expect(heading).toHaveText('cybermole');
  await expect(heading).toHaveAttribute('title', 'cybermole');
});

// ---------- the page-entry fade ----------

test('console pages fade in; reduced motion skips the animation', async ({ page }) => {
  await login(page);
  expect(await pageEnterAnimation(page)).toBe('cybermole-page-enter');
  await page.goto('/builder');
  await page.waitForSelector('workspace-sidebar .nav');
  expect(await pageEnterAnimation(page)).toBe('cybermole-page-enter');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.waitForSelector('console-app');
  expect(await pageEnterAnimation(page)).toBe('none');
});

// ---------- the desktop nav collapse ----------

test('the nav collapse toggles a rail and persists across reload', async ({ page }) => {
  await login(page);
  const toggle = page.locator('#nav-collapse');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Collapse: the sidebar hides, the expand chevron shows in the rail.
  await toggle.click();
  await expect(page.locator('workspace-sidebar')).toBeHidden();
  await expect(page.locator('console-app')).toHaveAttribute('data-nav-collapsed', '');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle.locator('wa-icon.when-collapsed')).toBeVisible();
  await expect(toggle.locator('wa-icon.when-open')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('cybermole:sidebar-collapsed'))).toBe(
    'true',
  );

  // The persisted state re-applies after a reload (both console pages).
  await page.reload();
  await page.waitForSelector('console-app');
  await expect(page.locator('workspace-sidebar')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/builder');
  await page.waitForSelector('console-app');
  await expect(page.locator('workspace-sidebar')).toBeHidden();

  // Expand again: the sidebar is back, and the memory clears.
  await toggle.click();
  await expect(page.locator('workspace-sidebar .nav')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => localStorage.getItem('cybermole:sidebar-collapsed'))).toBe(
    'false',
  );
});

// ---------- the new-app dialog's directory suggestion ----------

test('the new-app dialog suggests a directory from the name until the cwd is edited', async ({
  page,
}) => {
  await login(page);
  await page.goto('/builder');
  await page.waitForSelector('workspace-sidebar .nav');
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);

  const cwdValue = (): Promise<string | null> =>
    page.evaluate(
      () =>
        (document.querySelector('wa-input#app-cwd') as unknown as { value: string | null }).value,
    );

  await page.click('workspace-sidebar #new-app');
  // Typing a name derives the slug (the server's own rule) under the
  // default cwd.
  await page.fill('wa-input#app-name input', 'Cosmetics App');
  await expect.poll(cwdValue).toBe(`${WORKSPACE}/cosmetics-app`);
  // A name that slugs to nothing suggests nothing.
  await page.fill('wa-input#app-name input', '???');
  await expect.poll(cwdValue).toBeNull();

  // Once the cwd is hand-edited, the name no longer re-suggests.
  await page.fill('wa-input#app-name input', 'Cosmetics App');
  await expect.poll(cwdValue).toBe(`${WORKSPACE}/cosmetics-app`);
  const hand = `${WORKSPACE}/hand-picked`;
  await page.fill('wa-input#app-cwd input', hand);
  await page.fill('wa-input#app-name input', 'Cosmetics App II');
  expect(await cwdValue()).toBe(hand);

  // Cancel (no row is created), reopen: fields reset, suggestions resume.
  await page.click('#app-dialog [data-dialog="close"]');
  await page.click('workspace-sidebar #new-app');
  expect(await cwdValue()).toBeNull();
  await page.fill('wa-input#app-name input', 'Cosmetics App');
  await expect.poll(cwdValue).toBe(`${WORKSPACE}/cosmetics-app`);
  await page.click('#app-dialog [data-dialog="close"]');
});
