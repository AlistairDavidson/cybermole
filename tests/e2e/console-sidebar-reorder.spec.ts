// Sidebar reorder against the shared suite server: workspace rows drag
// within the console group and app groups drag on the builder page, both
// optimistic and persistent across a reload; Shift+Arrow is the keyboard
// half, mirroring the terminal tab bar's affordance.
//
// Apps-spec discipline: one login() through the shared cookie file (env.ts);
// each test sweeps its own rows at entry and deletes them again, so the
// fixture world is unchanged. Sorts BEFORE e2e.spec.ts on purpose: its
// logout tests kill the shared session and its last test exhausts the
// login budget, so anything after it must sign in fresh.
import { expect, test, type Cookie, type Page } from '@playwright/test';
import {
  PASSWORD,
  USERNAME,
  readSharedSessionCookie,
  writeSharedSessionCookie,
} from '../support/env';

// ---------- shared helpers (the apps-spec shape) ----------

let sessionCookie: Cookie | null = null;
async function login(page: Page, path: '/' | '/builder' = '/'): Promise<void> {
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
    await page.goto(path);
    if (!page.url().includes('/login')) {
      await page.waitForSelector('workspace-sidebar .nav');
      return;
    }
    // The shared session died (a logout test ran): fall through to a fresh
    // sign-in, which also refreshes the file for the next spec.
    sessionCookie = null;
  }
  await page.goto('/login');
  await page.fill('wa-input#username input', USERNAME);
  await page.fill('wa-input#password input', PASSWORD);
  await page.click('wa-button:has-text("sign in")');
  await page.waitForURL(u => u.pathname === '/');
  sessionCookie =
    (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
  if (sessionCookie) writeSharedSessionCookie(`${sessionCookie.name}=${sessionCookie.value}`);
  await page.goto(path);
  await page.waitForSelector('workspace-sidebar .nav');
}

async function api(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, callers narrow it
Promise<{ status: number; json: any }> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u!, {
        method: m!,
        ...(b === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }),
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, url, body] as const,
  );
}

/** Forces the 15 s poll; raw in-page POSTs don't trigger it. */
async function refreshState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = document.querySelector('console-app') as unknown as {
      loadState(): Promise<void>;
      loadAppsStatus(): Promise<void>;
    };
    await app.loadState();
    await app.loadAppsStatus();
  });
}

/** Idempotent: drops any leftover rows from a re-run of this file's tests. */
async function sweep(page: Page, workspaces: string[], appSlugs: string[]): Promise<void> {
  const st = await api(page, 'GET', '/api/state');
  if (st.status === 200)
    for (const w of st.json.workspaces ?? [])
      if (workspaces.includes(w.name)) await api(page, 'DELETE', `/api/workspaces/${w.id}`);
  for (const slug of appSlugs) await api(page, 'DELETE', `/api/apps/${slug}`);
}

/** Resolves once the sidebar's order write lands, so a reload can't race it. */
const orderPut = (page: Page, path: string) =>
  page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === path);

/** The console group's row names in display order. */
const rowNames = (page: Page) =>
  page
    .locator('workspace-sidebar .ws-group[data-group="console"] li[data-ws] .t-name')
    .allTextContents();

/** The builder page's app-row group slugs in display order (a group with
 *  + workspace has a row; earlier specs' unregistered trees don't count). */
const groupSlugs = (page: Page) =>
  page
    .locator('workspace-sidebar .ws-group')
    .evaluateAll(gs =>
      gs
        .filter(g => g.querySelector('[data-new-ws]') !== null)
        .map(g => g.getAttribute('data-group') ?? ''),
    );

/** Where a slug currently sits in the portfolio (app-row groups only). */
const groupIndex = async (page: Page, slug: string): Promise<number> =>
  (await groupSlugs(page)).indexOf(slug);

// ---------- workspace rows (console page) ----------

test('dragging a workspace row reorders its group optimistically and the order survives a reload', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const NAMES = ['sidebar order one', 'sidebar order two'];
  await sweep(page, NAMES, []);
  const one = await api(page, 'POST', '/api/workspaces', { name: NAMES[0] });
  const two = await api(page, 'POST', '/api/workspaces', { name: NAMES[1] });
  expect(one.status, JSON.stringify(one.json)).toBe(200);
  expect(two.status, JSON.stringify(two.json)).toBe(200);
  await refreshState(page);
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'deploy checklist', 'sidebar order one', 'sidebar order two']);

  // Drop 'two' on the top half of 'one': it lands above it, and the fixture
  // rows keep their relative order (rows reorder within their group only).
  const put = orderPut(page, '/api/workspaces/order');
  await page
    .locator(`workspace-sidebar li[data-ws="${two.json.id}"]`)
    .dragTo(page.locator(`workspace-sidebar li[data-ws="${one.json.id}"]`), {
      targetPosition: { x: 8, y: 2 },
    });
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'deploy checklist', 'sidebar order two', 'sidebar order one']);
  expect((await put).status()).toBe(200);

  // The write landed: a fresh boot renders the same order.
  await page.reload();
  await page.waitForSelector('workspace-sidebar .nav');
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'deploy checklist', 'sidebar order two', 'sidebar order one']);
  await sweep(page, NAMES, []);
});

test('Shift+Arrow moves the focused workspace row, and that order survives a reload too', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const NAMES = ['sidebar order one', 'sidebar order two'];
  await sweep(page, NAMES, []);
  await api(page, 'POST', '/api/workspaces', { name: NAMES[0] });
  const two = await api(page, 'POST', '/api/workspaces', { name: NAMES[1] });
  await refreshState(page);
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'deploy checklist', 'sidebar order one', 'sidebar order two']);

  // Keyboard alternative to the drag: focus a row, Shift+ArrowUp walks it
  // up one slot a hop. Two hops move 'two' past both neighbours (each
  // hop's write is awaited before the next, so a reload can't race a PUT).
  await page.locator(`workspace-sidebar li[data-ws="${two.json.id}"]`).focus();
  const put1 = orderPut(page, '/api/workspaces/order');
  await page.keyboard.press('Shift+ArrowUp');
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'deploy checklist', 'sidebar order two', 'sidebar order one']);
  expect((await put1).status()).toBe(200);
  const put2 = orderPut(page, '/api/workspaces/order');
  await page.keyboard.press('Shift+ArrowUp');
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'sidebar order two', 'deploy checklist', 'sidebar order one']);
  expect((await put2).status()).toBe(200);

  // Plain arrows only walk focus: the list keeps its order.
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'sidebar order two', 'deploy checklist', 'sidebar order one']);

  // A filtered view can't name a full-group order: Shift+Arrow is inert.
  await page.fill('wa-input#workspace-search input', 'sidebar');
  await expect.poll(() => rowNames(page)).toEqual(['sidebar order two', 'sidebar order one']);
  await page.locator(`workspace-sidebar li[data-ws="${two.json.id}"]`).focus();
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(300);
  await expect.poll(() => rowNames(page)).toEqual(['sidebar order two', 'sidebar order one']);
  await page.fill('wa-input#workspace-search input', '');

  await page.reload();
  await page.waitForSelector('workspace-sidebar .nav');
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'sidebar order two', 'deploy checklist', 'sidebar order one']);
  await sweep(page, NAMES, []);
});

test('a state poll landing mid-drag defers its re-render: the drag survives and lands', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const NAMES = ['sidebar order one', 'sidebar order two'];
  await sweep(page, NAMES, []);
  const one = await api(page, 'POST', '/api/workspaces', { name: NAMES[0] });
  const two = await api(page, 'POST', '/api/workspaces', { name: NAMES[1] });
  await refreshState(page);
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'deploy checklist', 'sidebar order one', 'sidebar order two']);

  // A hand-driven drag: down, move (the drag starts), then the 15 s poll
  // lands — render defers to dragend instead of swapping innerHTML under
  // the pointer — then the drop completes over 'one's top half.
  const src = (await page.locator(`workspace-sidebar li[data-ws="${two.json.id}"]`).boundingBox())!;
  const tgt = (await page.locator(`workspace-sidebar li[data-ws="${one.json.id}"]`).boundingBox())!;
  const put = orderPut(page, '/api/workspaces/order');
  await page.mouse.move(src.x + 12, src.y + 4);
  await page.mouse.down();
  await page.mouse.move(src.x + 12, src.y - 10, { steps: 3 });
  await refreshState(page);
  await page.mouse.move(tgt.x + 12, tgt.y + 3, { steps: 3 });
  await page.mouse.up();
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'deploy checklist', 'sidebar order two', 'sidebar order one']);
  expect((await put).status()).toBe(200);

  // The deferred render ran (at dragend) and kept the dropped order.
  await page.reload();
  await page.waitForSelector('workspace-sidebar .nav');
  await expect
    .poll(() => rowNames(page))
    .toEqual(['scratch', 'deploy checklist', 'sidebar order two', 'sidebar order one']);
  await sweep(page, NAMES, []);
});

// ---------- app groups (builder page) ----------

test('dragging an app group reorders the portfolio optimistically and the order survives a reload', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page, '/builder');
  const SLUGS = ['zz-reorder-a', 'zz-reorder-b'];
  await sweep(page, [], SLUGS);
  const a = await api(page, 'POST', '/api/apps', { name: 'zz reorder a' });
  const b = await api(page, 'POST', '/api/apps', { name: 'zz reorder b' });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  expect(b.status, JSON.stringify(b.json)).toBe(200);
  await refreshState(page);
  await expect
    .poll(async () => groupIndex(page, 'zz-reorder-a'))
    .toBeLessThan(await groupIndex(page, 'zz-reorder-b'));
  const before = await groupIndex(page, 'zz-reorder-b');

  // Drop b's header on the top half of a's header: b lands directly above
  // it. The source position steers clear of the header's buttons.
  const put = orderPut(page, '/api/apps/order');
  await page
    .locator(`workspace-sidebar .ws-group[data-group="zz-reorder-b"] h2`)
    .dragTo(page.locator(`workspace-sidebar .ws-group[data-group="zz-reorder-a"] h2`), {
      sourcePosition: { x: 60, y: 4 },
      targetPosition: { x: 60, y: 2 },
    });
  await expect.poll(async () => groupIndex(page, 'zz-reorder-b')).toBe(before - 1);
  expect(await groupIndex(page, 'zz-reorder-a')).toBe(before);
  expect((await put).status()).toBe(200);

  // The write landed: a fresh boot renders the same order.
  await page.reload();
  await page.waitForSelector('workspace-sidebar .nav');
  await expect.poll(async () => groupIndex(page, 'zz-reorder-b')).toBe(before - 1);
  expect(await groupIndex(page, 'zz-reorder-a')).toBe(before);
  await sweep(page, [], SLUGS);
});

test('Shift+Arrow moves the focused app group, and that order survives a reload too', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page, '/builder');
  const SLUGS = ['zz-reorder-a', 'zz-reorder-b'];
  await sweep(page, [], SLUGS);
  await api(page, 'POST', '/api/apps', { name: 'zz reorder a' });
  await api(page, 'POST', '/api/apps', { name: 'zz reorder b' });
  await refreshState(page);
  await expect
    .poll(async () => groupIndex(page, 'zz-reorder-a'))
    .toBeLessThan(await groupIndex(page, 'zz-reorder-b'));
  const start = await groupIndex(page, 'zz-reorder-b');

  // Keyboard alternative to the drag: focus a group header, Shift+ArrowUp
  // walks it up one slot a hop (each hop's write is awaited before the
  // next, so a reload can't race a PUT).
  await page.locator('workspace-sidebar .ws-group[data-group="zz-reorder-b"] h2').focus();
  const put1 = orderPut(page, '/api/apps/order');
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => groupIndex(page, 'zz-reorder-b')).toBe(start - 1);
  expect((await put1).status()).toBe(200);
  const put2 = orderPut(page, '/api/apps/order');
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => groupIndex(page, 'zz-reorder-b')).toBe(start - 2);
  expect((await put2).status()).toBe(200);

  // Plain arrows only walk focus: the portfolio keeps its order.
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => groupIndex(page, 'zz-reorder-b')).toBe(start - 2);

  await page.reload();
  await page.waitForSelector('workspace-sidebar .nav');
  await expect.poll(async () => groupIndex(page, 'zz-reorder-b')).toBe(start - 2);
  await sweep(page, [], SLUGS);
});
