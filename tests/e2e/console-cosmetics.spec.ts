// Console cosmetics: the cybermole product label (title, nav, sidebar
// heading), the page-entry fade (and its reduced-motion skip), the
// desktop nav collapse (persisted, rail with the expand control), the
// mobile drawer toggle in the top bar, the brand glyph's page-current
// highlight, and the new-app dialog's directory suggestion from the name.
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

/** The shell wa-page's computed animation-name (persists after the run). */
function pageEnterAnimation(page: Page): Promise<string> {
  return page.evaluate(
    () => getComputedStyle(document.querySelector('wa-page.app-page')!).animationName,
  );
}

// ---------- the product label ----------

test('the product shows as cybermole: page title, nav brand, sidebar group heading', async ({
  page,
}) => {
  await login(page);
  await expect(page).toHaveTitle('cybermole');
  // The header's brand link (icon button): its name rides the glyph's
  // label, and a wa-tooltip says it to sighted users.
  await expect(page.locator('app-header wa-button.app-brand wa-icon')).toHaveAttribute(
    'label',
    'Cybermole',
  );
  await expect(page.locator('wa-tooltip[for="nav-console"]')).toHaveText('Cybermole');
  // The / page's single group names the product, not "console".
  const heading = page.locator('workspace-sidebar .ws-group .g-name');
  await expect(heading).toHaveText('cybermole');
  await expect(
    page.locator(`workspace-sidebar wa-tooltip[for="${await heading.getAttribute('id')}"]`),
  ).toHaveText('cybermole');
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
  await expect(page.locator('wa-page.app-page')).toHaveAttribute('data-nav-collapsed', '');
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

// ---------- the mobile drawer toggle ----------

test('on mobile the drawer toggle sits far left of the top bar and drives the drawer', async ({
  page,
}) => {
  await login(page);
  const toggle = page.locator('app-header #nav-drawer-toggle');
  const thePage = page.locator('wa-page.app-page');

  // Wide: the sidebar is inline and the toggle is a mobile-only control.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(thePage).not.toHaveAttribute('view', 'mobile');
  await expect(toggle).toBeHidden();
  await expect(page.locator('workspace-sidebar .nav')).toBeVisible();

  // Narrow: wa-page flips to its mobile view, the toggle appears at the
  // top bar's far left (the first control of the left cluster), and the
  // stock hamburger's header row is gone.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(thePage).toHaveAttribute('view', 'mobile');
  await expect(toggle).toBeVisible();
  const firstClusterControl = page.locator('app-header nav.wa-cluster > :first-child');
  await expect(firstClusterControl).toHaveAttribute('id', 'nav-drawer-toggle');

  // Opening: the drawer carries the sidebar, the button's disclosure
  // semantics follow (icon flips to the close glyph).
  await toggle.click();
  await expect(thePage).toHaveAttribute('nav-open', '');
  await expect(page.locator('wa-drawer[open]')).toHaveCount(1);
  await expect(page.locator('workspace-sidebar .nav')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle.locator('wa-icon')).toHaveAttribute('name', 'xmark');

  // Escape closes (light-dismiss would too); the semantics follow back.
  await page.keyboard.press('Escape');
  await expect(thePage).not.toHaveAttribute('nav-open', '');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle.locator('wa-icon')).toHaveAttribute('name', 'bars');

  // Pages without the console drawer never show the toggle.
  await page.goto('/jobs');
  await page.waitForSelector('jobs-app');
  await expect(page.locator('app-header #nav-drawer-toggle')).toBeHidden();
});

// ---------- the brand glyph's page-current highlight ----------

test('the brand glyph is monochrome ink: it takes the current-page colour like its siblings', async ({
  page,
}) => {
  await login(page);
  // The button part's colour is what every slotted icon inherits; the
  // brand-library mole glyph (currentColor) rides the same chain.
  const colors = () =>
    page.evaluate(() => {
      const partColor = (btn: Element): string => {
        const part = (btn.shadowRoot as ShadowRoot).querySelector('[part~="button"]')!;
        return getComputedStyle(part).color;
      };
      return {
        glyph: getComputedStyle(document.querySelector('app-header wa-button.app-brand wa-icon')!)
          .color,
        current: partColor(document.querySelector("app-header wa-button[aria-current='page']")!),
        resting: partColor(document.querySelector("app-header wa-button[href$='/jobs']")!),
      };
    });

  // Home: the brand owns the highlight.
  const home = await colors();
  expect(home.glyph).toBe(home.current);
  expect(home.current).not.toBe(home.resting);

  // Away: it rests at the same colour as every other non-current icon.
  await page.goto('/builder');
  await page.waitForSelector('workspace-sidebar .nav');
  const away = await colors();
  expect(away.glyph).toBe(away.resting);
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
