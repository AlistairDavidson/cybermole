// Console cosmetics: the cybermole product label (title, nav, sidebar
// heading), the in-place page navigations (the live shell, the drawer's own close), the
// desktop sidebar hide (persisted, the hamburger leading the tab strip),
// the mobile drawer toggle in the same place, the same shell on the pages
// without tabs, and the new-app dialog's directory suggestion from the name.
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
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
}

/** Counts view transitions started, into window.vtStarted — an init
 *  script, so it wraps startViewTransition before any page code. */
async function countViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { vtStarted: number };
    w.vtStarted = 0;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (update?: ViewTransitionUpdateCallback) => {
      w.vtStarted += 1;
      return start(update);
    };
  });
}

/** Whether the window and the wa-page shell are the ones marked before. */
function sameShell(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as { shell?: Element | null };
    return w.shell !== undefined && w.shell === document.querySelector('wa-page.app-page');
  });
}

function markShell(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { shell: Element | null }).shell =
      document.querySelector('wa-page.app-page');
  });
}

// ---------- the product label ----------

test('the product shows as cybermole: page title, nav item', async ({ page }) => {
  await login(page);
  await expect(page).toHaveTitle('cybermole');
  // No header bar (so no brand logo or breadcrumb): the tab strip is the
  // top row, and the side nav's first item is the product.
  await expect(page.locator('app-header')).toHaveCount(0);
  await expect(page.locator('wa-breadcrumb')).toHaveCount(0);
  const item = page.locator('side-nav #nav-console');
  await expect(item).toHaveAttribute('aria-current', 'page');
  await expect(item.locator('.side-nav-row > span')).toHaveText('Cybermole');
  const glyph = item.locator('.side-nav-row > wa-icon');
  await expect(glyph).toHaveAttribute('library', 'brand');
  await expect(glyph).toHaveAttribute('name', 'mole');
  await expect(glyph).toHaveAttribute('label', 'Cybermole');
});

// ---------- page transitions ----------

test('navigations swap the content into the live shell, back and forward too', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await login(page);
  await countViewTransitions(page);
  await page.goto('/builder');
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\bwa-dark\b/);
  // The window, the wa-page and the nav element survive only an in-place swap.
  await markShell(page);
  await page.evaluate(() => {
    (window as unknown as { nav: Element | null }).nav = document.querySelector('side-nav');
  });
  await page.locator('side-nav #nav-jobs a').click();
  await page.waitForURL(url => url.pathname === '/jobs');
  await expect(page.locator('#jobs-new')).toBeVisible();
  expect(await sameShell(page)).toBe(true);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { nav: Element | null }).nav === document.querySelector('side-nav'),
    ),
  ).toBe(true);
  await expect(page).toHaveTitle('cybermole — jobs');
  // The persisted nav takes the next page's selection.
  await expect(page.locator('side-nav #nav-jobs')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('side-nav #nav-builder')).not.toHaveAttribute('aria-current', 'page');
  // The swapped-in wa-* hydrate their SSR'd shadow roots rather than render
  // a second copy (one button's height, no hydration errors).
  expect((await page.locator('#jobs-new').boundingBox())?.height).toBeLessThan(50);
  expect(errors.filter(e => e.includes('root part'))).toEqual([]);
  // The html element is never swapped: the mode class stays.
  await expect(page.locator('html')).toHaveClass(/\bwa-dark\b/);

  await page.goBack();
  await page.waitForURL(url => url.pathname === '/builder');
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
  expect(await sameShell(page)).toBe(true);
  await expect(page.locator('side-nav #nav-builder')).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await page.waitForURL(url => url.pathname === '/jobs');
  await expect(page.locator('#jobs-new')).toBeVisible();
  expect(await sameShell(page)).toBe(true);
  // No view transition freezes the page.
  expect(await page.evaluate(() => (window as unknown as { vtStarted: number }).vtStarted)).toBe(0);
});

test('mobile: a drawer link swaps the page under the drawer, which shuts as in-page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await login(page);
  const shell = page.locator('wa-page.app-page');
  await expect(shell).toHaveAttribute('view', 'mobile');
  await markShell(page);
  await page.locator('#nav-drawer-toggle').click();
  await expect(shell).toHaveAttribute('nav-open', '');
  // wa-page's own drawer hides (its wa-hide), as a toggle or backdrop tap does.
  await page.evaluate(() => {
    const drawer = document
      .querySelector('wa-page.app-page')!
      .shadowRoot!.querySelector('wa-drawer')!;
    drawer.addEventListener('wa-hide', () => {
      (window as unknown as { hid: string }).hid = location.pathname;
    });
  });
  await page.locator('side-nav #nav-jobs a').click();
  await page.waitForURL(url => url.pathname === '/jobs');
  await expect(shell).not.toHaveAttribute('nav-open');
  expect(await sameShell(page)).toBe(true);
  // It began shutting once the next page was in.
  expect(await page.evaluate(() => (window as unknown as { hid?: string }).hid)).toBe('/jobs');
  await expect(page.locator('#jobs-new')).toBeVisible();
  await expect(page.locator('#nav-drawer-toggle')).toHaveAttribute('aria-expanded', 'false');
});

// ---------- the navigation toggles ----------

/** The shown button of the first displayed control in the tab strip's nav. */
function firstStripControl(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const group = document.querySelector('terminal-tabs > wa-tab-group')!;
    const shown = (el: Element): boolean => getComputedStyle(el).display !== 'none';
    const first = [...group.querySelectorAll(':scope > [slot="nav"]')].find(shown);
    if (first?.localName !== 'nav-toggle') return null;
    return [...first.querySelectorAll('wa-button')].find(shown)?.id ?? null;
  });
}

test('desktop: the hamburger leads the tab strip, hides the sidebar, and persists', async ({
  page,
}) => {
  await login(page);
  const toggle = page.locator('#nav-collapse');
  await expect(toggle).toBeVisible();
  await expect(page.locator('#nav-drawer-toggle')).toBeHidden();
  expect(await firstStripControl(page)).toBe('nav-collapse');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // The old in-sidebar collapse arrow is gone.
  await expect(page.locator('[slot="navigation-footer"] wa-icon[name^="chevron"]')).toHaveCount(0);

  // Hide: the whole column goes, the hamburger stays.
  await toggle.click();
  await expect(page.locator('side-nav')).toBeHidden();
  await expect(page.locator('wa-page.app-page')).toHaveAttribute('data-nav-collapsed', '');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => localStorage.getItem('cybermole:sidebar-collapsed'))).toBe(
    'true',
  );

  // The persisted state re-applies after a reload (both console pages).
  await page.reload();
  await page.waitForSelector('console-app');
  await expect(page.locator('side-nav')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/builder');
  await page.waitForSelector('console-app');
  await expect(page.locator('side-nav')).toBeHidden();

  // Show again: the column is back, and the memory clears.
  await toggle.click();
  await expect(page.locator('side-nav')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => localStorage.getItem('cybermole:sidebar-collapsed'))).toBe(
    'false',
  );
});

test('on mobile the drawer toggle leads the tab strip and drives the drawer', async ({ page }) => {
  await login(page);
  const toggle = page.locator('#nav-drawer-toggle');
  const thePage = page.locator('wa-page.app-page');

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(thePage).toHaveAttribute('view', 'mobile');
  await expect(toggle).toBeVisible();
  await expect(page.locator('#nav-collapse')).toBeHidden();
  expect(await firstStripControl(page)).toBe('nav-drawer-toggle');

  // Opening: the drawer carries the side nav, the button's disclosure
  // semantics follow (icon flips to the close glyph).
  await toggle.click();
  await expect(thePage).toHaveAttribute('nav-open', '');
  await expect(page.locator('wa-drawer[open]')).toHaveCount(1);
  await expect(page.locator('side-nav')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle.locator('wa-icon')).toHaveAttribute('name', 'xmark');

  // Escape closes (light-dismiss would too); the semantics follow back.
  await page.keyboard.press('Escape');
  await expect(thePage).not.toHaveAttribute('nav-open', '');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle.locator('wa-icon')).toHaveAttribute('name', 'bars');
});

// ---------- every page wears the shell ----------

test('pages without tabs get the same side nav and a top row led by the toggle', async ({
  page,
}) => {
  await login(page);
  for (const [path, section] of [
    ['/jobs', 'jobs'],
    ['/settings', 'settings'],
    ['/apps', 'apps-all'],
  ] as const) {
    await page.goto(path);
    await expect(page.locator('side-nav')).toBeVisible();
    await expect(page.locator('app-header')).toHaveCount(0);
    const row = page.locator('wa-page.app-page > .top-row');
    await expect(row.locator('#nav-collapse')).toBeVisible();
    await expect(page.locator(`#nav-${section}`)).toHaveAttribute('aria-current', 'page');
  }

  // The hide carries over from page to page.
  await page.click('#nav-collapse');
  await expect(page.locator('side-nav')).toBeHidden();
  await page.goto('/jobs');
  await expect(page.locator('#nav-collapse')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('side-nav')).toBeHidden();
  await page.click('#nav-collapse');
  await expect(page.locator('side-nav')).toBeVisible();

  // On mobile the same row opens the drawer.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.locator('wa-page.app-page')).toHaveAttribute('view', 'mobile');
  await page.click('#nav-drawer-toggle');
  await expect(page.locator('wa-page.app-page')).toHaveAttribute('nav-open', '');
  await expect(page.locator('side-nav #nav-jobs')).toBeVisible();
});

// ---------- the new-app dialog's directory suggestion ----------

test('the new-app dialog suggests a directory from the name until the cwd is edited', async ({
  page,
}) => {
  await login(page);
  await page.goto('/builder');
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);

  const cwdValue = (): Promise<string | null> =>
    page.evaluate(
      () =>
        (document.querySelector('wa-input#app-cwd') as unknown as { value: string | null }).value,
    );

  await page.click('app-switcher #app-switch');
  await page.click('app-switcher .app-new');
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
  await page.click('app-switcher #app-switch');
  await page.click('app-switcher .app-new');
  expect(await cwdValue()).toBeNull();
  await page.fill('wa-input#app-name input', 'Cosmetics App');
  await expect.poll(cwdValue).toBe(`${WORKSPACE}/cosmetics-app`);
  await page.click('#app-dialog [data-dialog="close"]');
});
