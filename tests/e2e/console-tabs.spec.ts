// Terminal tab UX against the shared suite server: drag and keyboard
// reorders are optimistic and persist across a reload, the + button and the
// caret menu open shell vs agent tabs (asserted through the pane's buffer
// marker, not side channels), and ctrl-t / ctrl-shift-t do the same from
// the keyboard — never while typing in a field or a dialog. The phone
// affordances: the toolbar's esc button sends the byte, the pane spends
// narrow viewports' width on columns, and touch drag scrolls the scrollback.
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
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
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

/** The server's persisted terminal order for a workspace — the reorder
 *  write's echo. The bar is optimistic, so a reload must wait on THIS, not
 *  on the DOM (a reload can kill the PUT still in flight). */
async function persistedOrder(page: Page, ws: string): Promise<string[]> {
  const state = await api(page, 'GET', '/api/state');
  const w = state.json.workspaces.find((x: { id: string }) => x.id === ws);
  return w.terminals.map((t: { id: string }) => t.id);
}

/** Workspace id → the slug of the throwaway app that owns it. */
const appOfWorkspace = new Map<string, string>();

/** A fresh workspace — a throwaway app's one workspace, opened on the
 * builder page — with titled tabs for stable labels:
 * [term 1 (the auto-opened agent tab), ...titles]. */
async function makeWorkspace(page: Page, name: string, titles: string[] = []): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const app = await api(page, 'POST', '/api/apps', { name: `${name} ${suffix}` });
  expect(app.status, JSON.stringify(app.json)).toBe(200);
  const made = await api(page, 'POST', '/api/workspaces', {
    appId: app.json.id,
    name,
    kind: 'build',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  for (const title of titles) {
    const term = await api(page, 'POST', `/api/workspaces/${made.json.id}/terminals`, { title });
    expect(term.status, JSON.stringify(term.json)).toBe(200);
  }
  appOfWorkspace.set(made.json.id as string, app.json.slug as string);
  await page.goto(`/builder?app=${app.json.slug}`);
  await page.waitForSelector('terminal-tabs wa-tab');
  return made.json.id as string;
}

/** Drops the owning app, and its workspace with it. */
async function deleteWorkspace(page: Page, ws: string): Promise<void> {
  const slug = appOfWorkspace.get(ws);
  expect(slug, 'a workspace made by makeWorkspace').toBeDefined();
  expect((await api(page, 'DELETE', `/api/apps/${slug}`)).status).toBe(200);
}

/** The visible pane's buffer, searched line by line. */
async function waitForTermText(page: Page, text: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    marker => {
      const el = document.querySelector(
        'agent-terminal:not(wa-tab-panel:not([active]) *)',
      ) as unknown as {
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
  return page.locator('terminal-tabs wa-tab .tab-label').allTextContents();
}

/** After a reload (?app= keeps the workspace's app selected): returns
 * once its bar is up. */
async function reselectWorkspace(page: Page, ws: string): Promise<void> {
  expect(appOfWorkspace.has(ws)).toBe(true);
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
  await page.waitForSelector('terminal-tabs wa-tab');
}

const tabOf = (page: Page, id: string) => page.locator(`terminal-tabs .tab[data-term="${id}"]`);
const tabIds = (page: Page) =>
  page
    .locator('terminal-tabs wa-tab')
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
  await page.waitForFunction(() => document.querySelectorAll('terminal-tabs wa-tab').length === 2);
  await waitForTermText(page, MARKER);
  expect(await tabIds(page)).toHaveLength(2);

  // The caret menu carries both kinds; the agent item is the distinct one.
  await page.click('terminal-tabs .tab-new-caret');
  const menu = page.locator('wa-dropdown[open] wa-dropdown-item');
  await expect(menu).toHaveCount(2);
  await menu.filter({ hasText: 'new agent tab' }).click();
  await page.waitForFunction(() => document.querySelectorAll('terminal-tabs wa-tab').length === 3);
  await waitForTermText(page, AGENT_MARKER);
  expect(await tabIds(page)).toHaveLength(3);
  // The strip tells them apart: a robot on the agent tabs, a prompt on the shell.
  await expect
    .poll(() =>
      page
        .locator('terminal-tabs wa-tab:not(.editor-tab) .tab-icon')
        .evaluateAll(icons => icons.map(i => i.getAttribute('name'))),
    )
    .toEqual(['robot', 'terminal', 'robot']);
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
  await page
    .locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container')
    .click();
  await page.keyboard.press('Control+t');
  await page.waitForFunction(() => document.querySelectorAll('terminal-tabs wa-tab').length === 2);
  await waitForTermText(page, MARKER);

  await page.keyboard.press('Control+Shift+t');
  await page.waitForFunction(() => document.querySelectorAll('terminal-tabs wa-tab').length === 3);
  await waitForTermText(page, AGENT_MARKER);

  // A focused text field keeps the keys: no third tab from the field in the
  // new-app dialog, and the dialog stays open.
  await page.click('app-switcher #app-switch');
  await page.click('app-switcher .app-new');
  await page.fill('wa-input#app-name input', 'shortcut guard');
  await page.keyboard.press('Control+t');
  await page.keyboard.press('Control+Shift+t');
  await page.waitForTimeout(500);
  expect(await tabIds(page)).toHaveLength(3);
  await expect(page.locator('#app-dialog')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  expect(await tabIds(page)).toHaveLength(3);
  await deleteWorkspace(page, ws);
});

// ---------- phone affordances ----------

// Soft keyboards have no esc or arrows; TUIs need them (closing dialogs,
// walking menus and history). The toolbar's menu sends them; `cat -v`
// renders ESC as ^[ in the buffer, so each pick is observed through the
// pane, not a side channel. Its close asks before ending the terminal.
test('the toolbar menu sends esc and arrows to the pane, and closes the tab', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  const ws = await makeWorkspace(page, 'esc button ws');
  await waitForTermText(page, AGENT_MARKER);

  const bar = page.locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-toolbar');
  const item = (value: string) => bar.locator(`.tb-menu wa-dropdown-item[value="${value}"]`);
  // The menu focuses its first item once its show animation ends; a pick
  // before that would have its focus hand-back stolen.
  const openMenu = async (): Promise<void> => {
    await bar.locator('.tb-menu .tb-trigger').click();
    await expect(item('up')).toBeFocused();
  };
  // Closed: only its trigger shows.
  await expect(item('esc')).toBeHidden();
  await openMenu();
  await expect(item('esc')).toBeVisible();
  // The tab strip holds no close of its own; the toolbar's is the one.
  await expect(page.locator('terminal-tabs wa-tab .tab-close')).toHaveCount(0);
  await expect(
    page.locator('terminal-tabs wa-tab:not(.editor-tab) wa-icon.tab-icon'),
  ).not.toHaveCount(0);

  // Opening the menu took focus; an outside click closes it and hands
  // focus back to the pane.
  await page
    .locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container')
    .click();
  await page.keyboard.type('cat -v\n');
  await waitForTermText(page, 'cat -v');
  // Let the shell exec cat (the echo above arrives while still typing);
  // then the bytes show in cat's output.
  await page.waitForTimeout(500);
  // One key per line: tmux would read ESC and a quick next key as one
  // meta key. Each pick hands focus back to the pane, so Enter lands in
  // it and cat echoes the line.
  for (const [value, shown] of [
    ['esc', 'X^[Y'],
    ['up', 'X^[[AY'],
    ['down', 'X^[[BY'],
  ] as const) {
    await page.keyboard.type('X');
    await openMenu();
    await item(value).click();
    await page.waitForTimeout(600);
    await page.keyboard.type('Y\n');
    await waitForTermText(page, shown, 10_000);
  }
  await page.keyboard.press('Control+c');

  const tabs = page.locator('terminal-tabs wa-tab[data-term]:not(.editor-tab)');
  const before = await tabs.count();
  await openMenu();
  await item('close').click();
  await page.click('#confirm-delete-ok');
  await expect(tabs).toHaveCount(before - 1);
  await deleteWorkspace(page, ws);
});

// Narrow viewports: the pane spends its width on columns, not padding —
// the terminal container spans the full viewport width.
test('the pane uses the full viewport width on narrow screens', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  const ws = await makeWorkspace(page, 'full width ws');
  await waitForTermText(page, AGENT_MARKER);

  await page.setViewportSize({ width: 480, height: 800 });
  // wa-page flips to its mobile view (the drawer) below 768px, and the body
  // column then TRANSITIONS to the drawer layout (300ms) — wait for the
  // pane to actually reach the viewport's left edge before measuring.
  await page.waitForSelector('wa-page.app-page[view="mobile"]');
  await expect
    .poll(
      async () =>
        (
          await page
            .locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container')
            .boundingBox()
        )?.x ?? 999,
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(1);
  const box = await page
    .locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container')
    .boundingBox();
  expect(box).not.toBeNull();
  // Within 1px of the viewport: no pane padding, no container margins.
  expect(Math.abs(box!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box!.x + box!.width - 480)).toBeLessThanOrEqual(1);

  await deleteWorkspace(page, ws);
});

// xterm has no touch scrolling of its own; agent-terminal's touch handlers
// drag the viewport through the scrollback (CDP-injected touch points — a
// drag DOWN reveals earlier lines, like every phone terminal).
test('touch drag scrolls the pane scrollback', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const ws = await makeWorkspace(page, 'touch scroll ws');
  await waitForTermText(page, AGENT_MARKER);

  // Fill the scrollback: 200 numbered lines, then wait for the last ones
  // (seq right-aligns to the widest — only 1- and 2-digit lines pad).
  await page.keyboard.type('seq 1 200\n');
  await waitForTermText(page, '199', 20_000);

  const viewport = page.locator(
    'agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container .xterm-viewport',
  );
  void viewport;
  const readViewportY = () =>
    page.evaluate(() => {
      const pane = document.querySelector(
        'agent-terminal:not(wa-tab-panel:not([active]) *)',
      ) as unknown as {
        terminal?: {
          rows: number;
          buffer: { active: { viewportY: number } };
        };
      };
      return pane?.terminal?.buffer.active.viewportY ?? -1;
    });
  const startTop = await readViewportY();
  // Parked at the bottom: viewportY == rows means NO scrollback (the seq
  // history must have landed) — anything more is scrollback to drag through.
  const rows = await page.evaluate(() => {
    const pane = document.querySelector(
      'agent-terminal:not(wa-tab-panel:not([active]) *)',
    ) as unknown as {
      terminal?: { rows: number };
    };
    return pane?.terminal?.rows ?? 0;
  });
  expect(startTop).toBeGreaterThan(rows);

  const box = await page
    .locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container')
    .boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: cx, y: cy }],
  });
  // A slow drag down (below the claim threshold, then past it): each move
  // is a separate event so the handler's claim logic runs for real.
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: cx, y: cy + i * 20 }],
    });
    await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  // The drag scrolled up into the scrollback: the buffer's viewport row
  // (parked at the bottom over ~200 lines of history) moved up by rows.
  await expect.poll(readViewportY, { timeout: 10_000 }).toBeLessThan(startTop - 5);

  await deleteWorkspace(page, ws);
});

// An app that asked for the mouse (pi fullscreen) owns its own scrolling:
// a touch drag reaches it as wheel reports, like the desktop wheel.
test('touch drag sends wheel reports when the pane tracks the mouse', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  const ws = await makeWorkspace(page, 'touch wheel ws');
  await waitForTermText(page, AGENT_MARKER);

  // SGR mouse tracking on; cat -v echoes what arrives (ESC as ^[).
  await page.keyboard.type("printf '\\033[?1000h\\033[?1006h'; cat -v\n");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pane = document.querySelector(
          'agent-terminal:not(wa-tab-panel:not([active]) *)',
        ) as unknown as { terminal?: { modes: { mouseTrackingMode: string } } };
        return pane?.terminal?.modes.mouseTrackingMode;
      }),
    )
    .not.toBe('none');

  const box = await page
    .locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container')
    .boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 4;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: cx, y: cy }],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: cx, y: cy + i * 20 }],
    });
    await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  // Finger down = wheel up = SGR button 64.
  await waitForTermText(page, '^[[<64;', 10_000);

  await deleteWorkspace(page, ws);
});

// ---------- the hand-off toast ----------

// An app's build session appearing out-of-band (an agent's build_session in
// a terminal, another tab's builder) while the console page is open: the
// page points the human at the builder page, where it lives.
test('an out-of-band build session toasts the builder page', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  await page.goto('/');
  await page.waitForSelector('terminal-tabs wa-tab');

  const app = await api(page, 'POST', '/api/apps', { name: 'Handoff Toast' });
  expect(app.status, JSON.stringify(app.json)).toBe(200);
  const made = await api(page, 'POST', '/api/workspaces', {
    appId: app.json.id,
    kind: 'build',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(200);

  // The events push lands the toast (naming the app) on the console page.
  await expect(page.locator('console-app wa-toast')).toContainText(
    'build session opened — Handoff Toast:',
    { timeout: 15_000 },
  );

  // The app delete cascades the session.
  expect((await api(page, 'DELETE', `/api/apps/${app.json.slug}`)).status).toBe(200);
});
