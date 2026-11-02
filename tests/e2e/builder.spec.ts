// The builder page (/builder — the console split): one app's one workspace
// at a time, picked in the app switcher at the end of the tab strip (with
// lifecycle chips, new app, the current app's actions); the workspace is a
// build session (kind 'build': the root cwd, framed by
// CYBERMOLE_WORKSPACE_FOCUS), created on first sight; deep links route by
// owner.
//
// Apps-spec discipline: one login() via the shared cookie file (env.ts); no
// afterAll (rows die with the per-run db, trees with the per-run WORKSPACE
// rm); per-test preconditions re-established idempotently (the flow-app
// sweep at each test's entry).
import { expect, test } from '@playwright/test';
import type { Cookie, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  AGENT_MARKER,
  APPS_ROOT,
  INTERNAL_SOCKET,
  MARKER,
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
    await page.goto('/builder');
  } else {
    await page.goto('/login');
    await page.fill('wa-input#username input', USERNAME);
    await page.fill('wa-input#password input', PASSWORD);
    await page.click('wa-button:has-text("sign in")');
    await page.waitForURL(u => u.pathname === '/');
    sessionCookie =
      (await page.context().cookies()).find(c => c.name === 'cybermole_session') ?? null;
    if (sessionCookie) writeSharedSessionCookie(`${sessionCookie.name}=${sessionCookie.value}`);
    await page.goto('/builder');
  }
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
}

/** Opens the app switcher's menu; its items are light-DOM children. */
async function openSwitcher(page: Page): Promise<void> {
  await page.click('app-switcher #app-switch');
  await expect(page.locator('app-switcher wa-dropdown')).toHaveAttribute('open', '');
}

/** One HTTP request over the internal API socket (rows live there). */
function callSocket(
  socketPath: string,
  method: 'GET' | 'POST' | 'DELETE',
  urlPath: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: urlPath }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function api(
  page: Page,
  method: string,
  url: string,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, callers narrow it
Promise<{ status: number; json: any }> {
  return page.evaluate(
    async ([m, u]) => {
      const r = await fetch(u!, { method: m! });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [method, url] as const,
  );
}

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
        if (
          buf
            .getLine(i)
            ?.translateToString(true)
            .includes(marker as string)
        )
          return true;
      }
      return false;
    },
    text,
    { timeout },
  );
}

/** Drops any leftover flow-app row so each test can create it through the
 *  UI. Idempotent by design: the scheduler may re-run a test. */
async function sweepFlowApp(): Promise<void> {
  await callSocket(INTERNAL_SOCKET, 'DELETE', '/apps/flow-app');
}

// ---------- the page itself ----------

test('the builder page: the switcher ends the strip with chips, the current app checked and its actions; / has none', async ({
  page,
}) => {
  await login(page);
  await sweepFlowApp();
  await page.goto('/builder?app=alpha-app');
  await expect(page.locator('workspace-sidebar')).toHaveCount(0);
  // The fixture's app (a row, no tree): its one workspace (proj) shows.
  const state = await api(page, 'GET', '/api/state');
  const alpha = (state.json.apps as { id: string; slug: string }[]).find(
    a => a.slug === 'alpha-app',
  )!;
  const proj = (
    state.json.workspaces as { appId: string | null; terminals: { id: string }[] }[]
  ).find(w => w.appId === alpha.id)!;
  await expect(
    page.locator(`terminal-tabs .tab[data-term="${proj.terminals[0]!.id}"]`),
  ).toHaveCount(1);
  // The switcher is the strip's last item, wearing the app's icon.
  const last = page.locator('terminal-tabs wa-tab-group > [slot="nav"]').last();
  await expect(last).toHaveJSProperty('localName', 'app-switcher');

  await openSwitcher(page);
  const item = page.locator(`app-switcher .app-item[value="app:${alpha.id}"]`);
  await expect(item).toHaveAttribute('checked');
  await expect(item.locator('.app-item-name')).toHaveText('alpha app');
  await expect(item.locator('.app-item-chip')).toHaveText('registered');
  await expect(page.locator('app-switcher .app-item[checked]')).toHaveCount(1);
  // The current app's actions: open (not serving: never mounted), its
  // settings page, new app, delete.
  await expect(page.locator('app-switcher .app-open')).toHaveAttribute('href', '/apps/alpha-app/');
  await expect(page.locator('app-switcher .app-open')).toContainText('not serving');
  await expect(page.locator('app-switcher .app-settings')).toHaveAttribute(
    'href',
    '/builder/alpha-app',
  );
  await expect(page.locator('app-switcher .app-new')).toBeVisible();
  await expect(page.locator('app-switcher .app-delete')).toContainText('delete alpha app');
  await page.keyboard.press('Escape');

  // The console page is orchestration only: no switcher, no new app.
  await page.goto('/');
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
  await expect(page.locator('app-switcher')).toHaveCount(0);
  await expect(page.locator('#app-dialog')).toHaveCount(0);
});

test('an unregistered tree shows in the switcher with its chip, not selectable', async ({
  page,
}) => {
  await login(page);
  // A scaffolded tree with no row — the state where "continue building" is
  // the point. Idempotent seed.
  const tree = path.join(APPS_ROOT, 'unreg-tree-app');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, 'app.json'), JSON.stringify({ name: 'Unreg Tree' }));

  // The status join is server-cached (~10 s, under the 15 s poll), so the
  // item may take a cache window to land. Poll the page's own refresh.
  const item = page.locator('app-switcher .app-item').filter({ hasText: 'Unreg Tree' });
  await expect
    .poll(
      async () => {
        await refreshState(page);
        return item.count();
      },
      { timeout: 25_000, intervals: [500, 1000, 2000, 2000] },
    )
    .toBe(1);
  await expect(item.locator('.app-item-chip')).toHaveText('unregistered tree');
  // No row, so no workspace to switch to.
  await expect(item).toHaveAttribute('disabled');
  await expect(item).not.toHaveAttribute('value');
  // The status join itself reports it.
  const status = await api(page, 'GET', '/api/apps/status');
  expect(status.status).toBe(200);
  expect(status.json.unregisteredTrees).toContain('unreg-tree-app');
});

test('builder flow: new app → its workspace opens as a build session → framing env in the pane → delete', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  await sweepFlowApp();
  await refreshState(page);
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);

  // The empty-name attempt below must POST nothing.
  const posts: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST') posts.push(new URL(r.url()).pathname);
  });

  // An empty name is blocked in the browser.
  await openSwitcher(page);
  await page.click('app-switcher .app-new');
  await page.click('#app-save');
  await expect(page.locator('#app-name-error')).toHaveText('name is required');
  expect(posts).toEqual([]);
  // The app's cwd still exists as a field; the build session won't use it
  // (kind 'build' skips the parent cwd) but frames its tree there.
  const appDir = `${WORKSPACE}/flow-app-dir`;
  fs.mkdirSync(appDir, { recursive: true });
  await page.fill('wa-input#app-name input', 'Flow App');
  await page.fill('wa-input#app-cwd input', appDir);
  await page.click('#app-save');

  // The new app is selected (and remembered in the URL), and its one
  // workspace was created on sight with its agent tab live.
  await page.waitForURL(u => u.searchParams.get('app') === 'flow-app');
  await expect(page).toHaveTitle('cybermole — builder — Flow App');
  const agentTab = page.locator('terminal-tabs wa-tab.tab:not(.editor-tab)');
  await expect(agentTab).toHaveCount(1);
  await expect(agentTab).toHaveAttribute('aria-label', /\(live\)/, { timeout: 10_000 });
  await waitForTermText(page, AGENT_MARKER, 20_000);
  const state = await api(page, 'GET', '/api/state');
  const flow = (state.json.apps as { id: string; slug: string }[]).find(
    a => a.slug === 'flow-app',
  )!;
  const ws = (
    state.json.workspaces as { appId: string | null; kind: string | null; cwd: string }[]
  ).filter(w => w.appId === flow.id);
  expect(ws).toHaveLength(1);
  expect(ws[0]).toMatchObject({ kind: 'build', cwd: WORKSPACE });
  expect(posts.filter(p => p === '/api/workspaces')).toHaveLength(1);

  // The framing one-liner rode the spawn: the session exists to build
  // flow-app, from the root cwd (not the app tree).
  await page
    .locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container')
    .click();
  await page.keyboard.type('echo FOCUS=$CYBERMOLE_WORKSPACE_FOCUS\n');
  await waitForTermText(page, 'FOCUS=flow-app', 10_000);
  await page.keyboard.type('pwd\n');
  await waitForTermText(page, WORKSPACE, 10_000);
  await page.keyboard.type('echo TREE=$CYBERMOLE_WORKSPACE_FOCUS_TREE\n');
  await waitForTermText(page, `TREE=${appDir}`, 10_000);

  // A + tab carries the framing too (spawn path two).
  await page.click('terminal-tabs .tab-new');
  await expect(page.locator('terminal-tabs wa-tab.tab:not(.editor-tab)')).toHaveCount(2);
  await expect
    .poll(() => page.locator('terminal-tabs wa-tab[active]').getAttribute('data-term'))
    .not.toBe(await agentTab.first().getAttribute('data-term'));
  const tabId = await page.locator('terminal-tabs wa-tab[active]').getAttribute('data-term');
  await expect(page.locator(`terminal-tabs .tab[data-term="${tabId}"]`)).toHaveAttribute(
    'aria-label',
    /\(live\)/,
    {
      timeout: 10_000,
    },
  );
  await waitForTermText(page, MARKER, 20_000);
  await page
    .locator('agent-terminal:not(wa-tab-panel:not([active]) *) .terminal-container')
    .click();
  await page.keyboard.type('echo FOCUS=$CYBERMOLE_WORKSPACE_FOCUS\n');
  await waitForTermText(page, 'FOCUS=flow-app', 10_000);

  // Deleting the app from the switcher takes its workspace with it; the
  // page falls back to another app.
  await openSwitcher(page);
  await page.click('app-switcher .app-delete');
  await expect(page.locator('#confirm-delete-text')).toContainText('Flow App');
  await page.click('#confirm-delete-ok');
  await expect(page.locator(`app-switcher .app-item[value="app:${flow.id}"]`)).toHaveCount(0);
  await expect(page.locator('app-switcher .app-item[checked]')).toHaveCount(1);
  const after = await api(page, 'GET', '/api/state');
  expect(
    (after.json.workspaces as { appId: string | null }[]).filter(w => w.appId === flow.id),
  ).toHaveLength(0);
});

test('switching apps swaps the workspace; the choice survives a reload (?app= and storage)', async ({
  page,
}) => {
  await login(page);
  await sweepFlowApp();
  const made = await page.evaluate(async () => {
    const r = await fetch('/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Switch Target' }),
    });
    return (await r.json()) as { id: string; slug: string };
  });
  await page.goto('/builder?app=alpha-app');
  const alphaTabs = await page.locator('terminal-tabs wa-tab.tab:not(.editor-tab)').count();
  expect(alphaTabs).toBeGreaterThan(0);

  await openSwitcher(page);
  await page.click(`app-switcher .app-item[value="app:${made.id}"]`);
  await page.waitForURL(u => u.searchParams.get('app') === made.slug);
  await expect(page).toHaveTitle('cybermole — builder — Switch Target');
  // Its workspace is ensured: one fresh agent tab.
  await expect(page.locator('terminal-tabs wa-tab.tab:not(.editor-tab)')).toHaveCount(1);
  await expect(page.locator('app-switcher .app-switch-icon')).toHaveAttribute(
    'label',
    'switch app (current: Switch Target)',
  );

  // Plain /builder reopens the last app.
  await page.goto('/builder');
  await page.waitForSelector('terminal-tabs:not([view="loading"])');
  await openSwitcher(page);
  await expect(page.locator(`app-switcher .app-item[value="app:${made.id}"]`)).toHaveAttribute(
    'checked',
  );
  await page.keyboard.press('Escape');

  // Clean up: the row and its workspace.
  expect((await api(page, 'DELETE', `/api/apps/${made.slug}`)).status).toBe(200);
});

test('deep links route by owner: app tabs bounce to /builder, console tabs to /', async ({
  page,
}) => {
  await login(page);
  await sweepFlowApp();
  // One terminal of each owner, through the API (the fixture's proj is an
  // app workspace; scratch's is the console's).
  const state = await api(page, 'GET', '/api/state');
  expect(state.status).toBe(200);
  const workspaces = state.json.workspaces as Array<{
    id: string;
    appId: string | null;
    terminals: Array<{ id: string }>;
  }>;
  const appWs = workspaces.find(w => w.appId !== null && w.terminals.length > 0);
  const consoleWs = workspaces.find(w => w.appId === null && w.terminals.length > 0);
  expect(appWs, JSON.stringify(workspaces)).toBeDefined();
  expect(consoleWs, JSON.stringify(workspaces)).toBeDefined();
  const appTerm = appWs!.terminals[0]!.id;
  const consoleTerm = consoleWs!.terminals[0]!.id;

  // /?t=<app tab> redirects client-side to /builder?t=… and selects it,
  // its app checked in the switcher.
  await page.goto(`/?t=${appTerm}`);
  await page.waitForURL(u => u.pathname === '/builder' && u.searchParams.get('t') === appTerm);
  await expect(page.locator(`app-switcher .app-item[value="app:${appWs!.appId}"]`)).toHaveAttribute(
    'checked',
  );
  await expect(page.locator(`terminal-tabs .tab[data-term="${appTerm}"]`)).toHaveAttribute(
    'active',
    '',
  );
  await expect(page.locator(`terminal-tabs .tab[data-term="${appTerm}"]`)).toHaveAttribute(
    'aria-label',
    /\(live\)/,
    {
      timeout: 10_000,
    },
  );

  // /builder?t=<console tab> bounces back to /.
  await page.goto(`/builder?t=${consoleTerm}`);
  await page.waitForURL(u => u.pathname === '/' && u.searchParams.get('t') === consoleTerm);
  await expect(page.locator(`terminal-tabs .tab[data-term="${consoleTerm}"]`)).toHaveAttribute(
    'active',
    '',
  );

  // Job runs are orchestration: /builder?run= goes home.
  await page.goto('/builder?run=j-itest-run');
  await page.waitForURL(u => u.pathname === '/' && u.searchParams.get('run') === 'j-itest-run');
});
