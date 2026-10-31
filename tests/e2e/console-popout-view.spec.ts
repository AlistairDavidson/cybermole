// /view — the popped-out single pane. The terminal pop-out opens this page
// (not the full console), it shows no console chrome, round-trips a
// keystroke through the fixture command, and a deep link respawns a dead
// session at the workspace cwd (the same attach semantics as the console).
//
// Apps-spec discipline: one login() through the shared cookie file (env.ts);
// each test sweeps its own workspace and deletes it again, so the fixture
// world is unchanged. Sorts before e2e.spec.ts, whose last test exhausts
// the shared login budget.
import { spawnSync } from 'node:child_process';
import { expect, test, type Cookie, type Locator, type Page } from '@playwright/test';
import {
  MARKER,
  PASSWORD,
  TMUX_SOCKET,
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

/** In-page fetch, so the Secure session cookie is sent. */
async function api(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body, callers narrow it
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

/** A fresh console workspace, selected, with one titled terminal whose id
 *  is returned (a stable label and a stable deep-link target). */
async function makeWorkspace(
  page: Page,
  name: string,
  title: string,
): Promise<{ ws: string; id: string }> {
  const made = await api(page, 'POST', '/api/workspaces', { name });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  const term = await api(page, 'POST', `/api/workspaces/${made.json.id}/terminals`, { title });
  expect(term.status, JSON.stringify(term.json)).toBe(200);
  await refreshState(page);
  await page.click(`workspace-sidebar wa-tree-item[data-ws="${made.json.id}"]`);
  return { ws: made.json.id as string, id: term.json.id as string };
}

async function deleteWorkspace(page: Page, ws: string): Promise<void> {
  expect((await api(page, 'DELETE', `/api/workspaces/${ws}`)).status).toBe(200);
}

/** 0 = the session exists. */
function hasSession(id: string): boolean {
  return (
    spawnSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', `t-${id}`], {
      stdio: 'ignore',
    }).status === 0
  );
}

/** Scoped to the visible pane: the workspace's auto-opened tab keeps a
 *  hidden, attached pane too. `state` is a modifier class ('.ok', …). */
const paneStatus = (page: Page, state = ''): Locator =>
  page.locator(`agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-status${state}`);

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

test('the terminal pop-out opens the chrome-free single view and round-trips a keystroke', async ({
  page,
}) => {
  await login(page);
  const { ws, id } = await makeWorkspace(page, 'popview ws', 'popview');
  try {
    await page.click(`terminal-tabs .tab[data-term="${id}"]`);
    await waitForTermText(page, MARKER);
    await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${id}`);

    const popBtn = page.locator(
      'terminal-tabs agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-toolbar .tb-pop-out',
    );
    await expect(popBtn).toBeVisible();
    const [pop] = await Promise.all([page.waitForEvent('popup'), popBtn.click()]);

    await pop.waitForSelector('single-view agent-terminal');
    await expect(pop).toHaveURL(new RegExp(`/view\\?t=${id}$`));
    // The single view, not the console: no header, nav, sidebar, tabs, dialogs.
    await expect(pop.locator('app-header')).toHaveCount(0);
    await expect(pop.locator('workspace-sidebar')).toHaveCount(0);
    await expect(pop.locator('terminal-tabs')).toHaveCount(0);
    await expect(pop.locator('wa-dialog')).toHaveCount(0);
    await expect(pop.locator('console-app')).toHaveCount(0);
    // document.title names the tab; the pane attaches through the same WS.
    await expect(pop).toHaveTitle('cybermole — popview');
    await expect(paneStatus(pop, '.ok')).toContainText(`attached: t-${id}`);
    // Already popped out: the pane's own pop-out button has nowhere to go.
    await expect(pop.locator('agent-terminal .tb-pop-out')).toBeHidden();
    await waitForTermText(pop, MARKER);

    // A keystroke round-trips through the fixture command.
    await pop.locator('agent-terminal .terminal-container').click();
    await pop.keyboard.type('echo VIEW_$((40+2))\n');
    await waitForTermText(pop, 'VIEW_42');

    // Closing the popout only detaches: the tmux session keeps running.
    await pop.close();
    expect(hasSession(id)).toBe(true);
  } finally {
    await deleteWorkspace(page, ws);
  }
});

test('a deep-linked /view respawns a dead session at the workspace cwd', async ({ page }) => {
  await login(page);
  const { ws, id } = await makeWorkspace(page, 'popview respawn', 'respawned');
  try {
    await page.click(`terminal-tabs .tab[data-term="${id}"]`);
    await waitForTermText(page, MARKER);

    // Kill the tmux session out of band: the next attach must respawn it.
    spawnSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `t-${id}`], { stdio: 'ignore' });
    await page.goto(`/view?t=${id}`);
    await page.waitForSelector('single-view agent-terminal');
    await expect(paneStatus(page, '.ok')).toContainText(`attached: t-${id}`);
    await waitForTermText(page, MARKER);
    await expect(page).toHaveTitle('cybermole — respawned');
  } finally {
    await deleteWorkspace(page, ws);
  }
});
