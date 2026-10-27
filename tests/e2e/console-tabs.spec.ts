// Terminal tab UX against the shared suite server: drag and keyboard
// reorders are optimistic and persist across a reload, the + button and the
// caret menu open shell vs agent tabs (asserted through the pane's buffer
// marker, not side channels), and ctrl-t / ctrl-shift-t do the same from
// the keyboard — never while typing in a field or a dialog.
//
// Apps-spec discipline: one login() through the shared cookie file (env.ts);
// each test sweeps its own workspace and deletes it again, so the fixture
// world is unchanged. Sorts before e2e.spec.ts, whose last test exhausts
// the shared login budget.
import { expect, test, type Cookie, type Page } from '@playwright/test';
import {
  AGENT_MARKER,
  MARKER,
  PASSWORD,
  USERNAME,
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
  }
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
  await page.evaluate(() =>
    (
      document.querySelector('console-app') as unknown as { loadState(): Promise<void> }
    ).loadState(),
  );
}

/** The server's persisted terminal order for a workspace — the reorder
 *  write's echo. The bar is optimistic, so a reload must wait on THIS, not
 *  on the DOM (a reload can kill the PUT still in flight). */
async function persistedOrder(page: Page, ws: string): Promise<string[]> {
  const state = await api(page, 'GET', '/api/state');
  const w = state.json.workspaces.find((x: { id: string }) => x.id === ws);
  return w.terminals.map((t: { id: string }) => t.id);
}

/** A fresh console workspace, selected, with titled tabs for stable labels:
 * [term 1 (the auto-opened agent tab), ...titles]. */
async function makeWorkspace(page: Page, name: string, titles: string[] = []): Promise<string> {
  const made = await api(page, 'POST', '/api/workspaces', { name });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  for (const title of titles) {
    const term = await api(page, 'POST', `/api/workspaces/${made.json.id}/terminals`, { title });
    expect(term.status, JSON.stringify(term.json)).toBe(200);
  }
  await refreshState(page);
  await page.click(`workspace-sidebar li[data-ws="${made.json.id}"]`);
  return made.json.id as string;
}

async function deleteWorkspace(page: Page, ws: string): Promise<void> {
  expect((await api(page, 'DELETE', `/api/workspaces/${ws}`)).status).toBe(200);
}

/** The visible pane's buffer, searched line by line. */
async function waitForTermText(page: Page, text: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    marker => {
      const el = document.querySelector('agent-terminal:not(.hidden)') as unknown as {
        terminal?: {
          buffer: {
            active: {
              length: number;
              getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
            };
          };
        };
      } | null;
      const buf = el?.terminal?.buffer.active;
      if (!buf) return false;
      for (let i = 0; i < buf.length; i++) {
        if (buf.getLine(i)?.translateToString(true).includes(marker)) return true;
      }
      return false;
    },
    text,
    { timeout },
  );
}

/** The bar's labels in display order (titles stay put; "term N" renumbers). */
async function tabLabels(page: Page): Promise<string[]> {
  return page.locator('terminal-tabs .tabs-bar .tab .tab-label').allTextContents();
}

/** Re-selects the workspace after a reload (the first fixture row would
 * otherwise win) and returns once its bar is up. */
async function reselectWorkspace(page: Page, ws: string): Promise<void> {
  await page.waitForSelector('workspace-sidebar .nav');
  await page.click(`workspace-sidebar li[data-ws="${ws}"]`);
  await page.waitForSelector('terminal-tabs .tabs-bar .tab');
}

const tabOf = (page: Page, id: string) => page.locator(`terminal-tabs .tab[data-term="${id}"]`);
const tabIds = (page: Page) =>
  page
    .locator('terminal-tabs .tabs-bar .tab')
    .evaluateAll(tabs => tabs.map(t => (t as HTMLElement).dataset.term ?? ''));

// ---------- reorder ----------

test('dragging a tab reorders the bar optimistically and the order survives a reload', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const ws = await makeWorkspace(page, 'tabs drag ws', ['one', 'two']);
  const [auto, one, two] = await tabIds(page);
  expect(await tabLabels(page)).toEqual(['term 1', 'one', 'two']);

  // Drop 'one' on the auto tab's left half: it lands before it, the auto
  // tab renumbers to "term 2" (labels follow position, titles don't).
  await tabOf(page, one!).dragTo(tabOf(page, auto!), { targetPosition: { x: 2, y: 4 } });
  await expect.poll(() => tabLabels(page)).toEqual(['one', 'term 2', 'two']);

  // The write landed (server echo, not just the optimistic bar): a fresh
  // boot renders the same order.
  await expect.poll(() => persistedOrder(page, ws)).toEqual([one, auto, two]);
  await page.reload();
  await reselectWorkspace(page, ws);
  await expect.poll(() => tabLabels(page)).toEqual(['one', 'term 2', 'two']);
  await deleteWorkspace(page, ws);
});

test('Shift+Arrow moves the focused tab, and that order survives a reload too', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const ws = await makeWorkspace(page, 'tabs keys ws', ['one', 'two']);
  const ids = await tabIds(page);
  const [auto, one, two] = ids;
  expect(await tabLabels(page)).toEqual(['term 1', 'one', 'two']);

  // Keyboard alternative to the drag: focus a tab, Shift+ArrowLeft walks it
  // left. Two hops move 'two' past both neighbours (the auto tab renumbers).
  await tabOf(page, two!).focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => tabLabels(page)).toEqual(['term 1', 'two', 'one']);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => tabLabels(page)).toEqual(['two', 'term 2', 'one']);

  // Plain arrows only walk focus: the bar keeps its order.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => tabLabels(page)).toEqual(['two', 'term 2', 'one']);
  // The second hop's write is in the server's echo before the reload can
  // kill it in flight (the bar above is only optimistic).
  await expect.poll(() => persistedOrder(page, ws)).toEqual([two, auto, one]);

  await page.reload();
  await reselectWorkspace(page, ws);
  await expect.poll(() => tabLabels(page)).toEqual(['two', 'term 2', 'one']);
  await deleteWorkspace(page, ws);
});

// ---------- new-tab affordances ----------

test("+ opens a shell tab; the caret menu's agent item opens an agent tab", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  const ws = await makeWorkspace(page, 'tabs kinds ws');
  expect(await tabIds(page)).toHaveLength(1);

  // + is the shell: the new tab is selected and its pane runs the shell
  // command (the fixture's shell banner), not the agent one.
  await page.click('terminal-tabs .tab-new[aria-label="new shell tab"]');
  await page.waitForFunction(
    () => document.querySelectorAll('terminal-tabs .tabs-bar .tab').length === 2,
  );
  await waitForTermText(page, MARKER);
  expect(await tabIds(page)).toHaveLength(2);

  // The caret menu carries both kinds; the agent item is the distinct one.
  await page.click('terminal-tabs .tab-new-caret');
  const menu = page.locator('wa-dropdown[open] wa-dropdown-item');
  await expect(menu).toHaveCount(2);
  await menu.filter({ hasText: 'new agent tab' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('terminal-tabs .tabs-bar .tab').length === 3,
  );
  await waitForTermText(page, AGENT_MARKER);
  expect(await tabIds(page)).toHaveLength(3);
  await deleteWorkspace(page, ws);
});

// ---------- keyboard shortcuts ----------

test('ctrl-t opens a shell tab and ctrl-shift-t an agent tab; neither fires in a field or open dialog', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  const ws = await makeWorkspace(page, 'tabs shortcut ws');
  expect(await tabIds(page)).toHaveLength(1);

  // Even with the terminal focused (xterm's hidden textarea holds focus)
  // the keys belong to the console, not the shell.
  await page.locator('agent-terminal:not(.hidden) .terminal-container').click();
  await page.keyboard.press('Control+t');
  await page.waitForFunction(
    () => document.querySelectorAll('terminal-tabs .tabs-bar .tab').length === 2,
  );
  await waitForTermText(page, MARKER);

  await page.keyboard.press('Control+Shift+t');
  await page.waitForFunction(
    () => document.querySelectorAll('terminal-tabs .tabs-bar .tab').length === 3,
  );
  await waitForTermText(page, AGENT_MARKER);

  // A focused text field keeps the keys: no third tab from the field in the
  // new-workspace dialog, and the dialog stays open.
  await page.locator('workspace-sidebar [data-new-ws]').first().click();
  await page.fill('wa-input#workspace-name input', 'shortcut guard');
  await page.keyboard.press('Control+t');
  await page.keyboard.press('Control+Shift+t');
  await page.waitForTimeout(500);
  expect(await tabIds(page)).toHaveLength(3);
  await expect(page.locator('#workspace-dialog')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  expect(await tabIds(page)).toHaveLength(3);
  await deleteWorkspace(page, ws);
});
