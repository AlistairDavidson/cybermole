// The builder page (/builder — the console split): the app portfolio with
// lifecycle chips and + app, build workspaces (kind 'build': the root cwd,
// framed by CYBERMOLE_WORKSPACE_FOCUS), and deep links routing by owner.
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
  await page.waitForSelector('workspace-sidebar .nav');
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

test('the builder page: app groups with lifecycle chips, + app and no console group; / is console-only', async ({
  page,
}) => {
  await login(page);
  await sweepFlowApp();
  const groups = page.locator('workspace-sidebar .ws-group');

  // The fixture's app group (a row, no tree): the *registered* chip, the
  // open link dimmed (never mounted), + workspace, delete.
  const alpha = page.locator('workspace-sidebar .ws-group[data-group="alpha-app"]');
  await expect(alpha.locator('.g-name')).toHaveText('alpha app');
  await expect(alpha.locator('.g-chip')).toHaveText('registered');
  await expect(alpha.locator('.open-app-btn')).toHaveClass(/not-serving/);
  await expect(alpha.locator('[data-new-ws]')).toHaveCount(1);
  await expect(alpha.locator('wa-tree-item[data-ws]')).toHaveCount(1); // the fixture's proj
  // No cybermole group here (that group is / only; the fixture cwds also
  // contain "cybermole", so the check pins the headings, not the rows), and
  // + app lives at the bottom.
  await expect(page.locator('workspace-sidebar #new-app')).toHaveCount(1);
  await expect(groups.locator('.g-name').filter({ hasText: 'cybermole' })).toHaveCount(0);

  // The console page is orchestration only: no app groups, no + app.
  await page.goto('/');
  await page.waitForSelector('workspace-sidebar .nav');
  await expect(page.locator('workspace-sidebar .ws-group')).toHaveCount(1);
  await expect(page.locator('workspace-sidebar .ws-group .g-name')).toHaveText('cybermole');
  await expect(page.locator('workspace-sidebar #new-app')).toHaveCount(0);
});

test('an unregistered tree shows with its chip and no row actions', async ({ page }) => {
  await login(page);
  // A scaffolded tree with no row — the state where "continue building" is
  // the point. Idempotent seed.
  const tree = path.join(APPS_ROOT, 'unreg-tree-app');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, 'app.json'), JSON.stringify({ name: 'Unreg Tree' }));

  // The status join is server-cached (~10 s, under the 15 s poll), so the
  // group may take a cache window to land. Poll the page's own refresh.
  const group = page.locator('workspace-sidebar .ws-group[data-group="unreg-tree-app"]');
  await expect
    .poll(
      async () => {
        await refreshState(page);
        return group.count();
      },
      { timeout: 25_000, intervals: [500, 1000, 2000, 2000] },
    )
    .toBe(1);
  await expect(group.locator('.g-name')).toHaveText('Unreg Tree');
  await expect(group.locator('.g-chip')).toHaveText('unregistered tree');
  // No row: no open link, no + workspace, no delete — the group is the
  // invitation to continue building (register it, or build on another app).
  await expect(group.locator('.open-app-btn')).toHaveCount(0);
  await expect(group.locator('[data-new-ws]')).toHaveCount(0);
  await expect(group.locator('[data-del-app]')).toHaveCount(0);
  await expect(group.locator('.group-empty')).toHaveText('no workspaces yet');
  // The status join itself reports it.
  const status = await api(page, 'GET', '/api/apps/status');
  expect(status.status).toBe(200);
  expect(status.json.unregisteredTrees).toContain('unreg-tree-app');
});

test('builder flow: + app → + workspace (a build session) → framing env in the pane → delete', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  await sweepFlowApp();
  await refreshState(page);
  await page.waitForFunction(() => customElements.get('validation-enhancer-zod') !== undefined);

  // The empty-name attempts below must POST nothing.
  const posts: string[] = [];
  page.on('request', r => {
    if (r.method() === 'POST') posts.push(new URL(r.url()).pathname);
  });

  // An empty name is blocked in the browser.
  await page.click('workspace-sidebar #new-app');
  await page.click('#app-save');
  await expect(page.locator('#app-name-error')).toHaveText('name is required');
  expect(posts).toEqual([]);
  // The app's cwd still exists as a field; the build session won't use it
  // (kind 'build' skips the parent cwd) but the row keeps it for later.
  const appDir = `${WORKSPACE}/flow-app-dir`;
  fs.mkdirSync(appDir, { recursive: true });
  await page.fill('wa-input#app-name input', 'Flow App');
  await page.fill('wa-input#app-cwd input', appDir);
  await page.click('#app-save');
  const group = page.locator('workspace-sidebar .ws-group[data-group="flow-app"]');
  await expect(group.locator('.g-name')).toHaveText('Flow App');
  await expect(group.locator('.g-chip')).toHaveText('registered');
  await expect(group.locator('.open-app-btn')).toHaveClass(/not-serving/);

  // The workspace dialog names the build-session derivation: the server
  // default cwd, framed at the app — never the app's own cwd.
  await group.locator('[data-new-ws]').click();
  await expect(page.locator('#workspace-dialog wa-input[name="cwd"]')).toHaveCount(0);
  await expect(page.locator('#workspace-start')).toHaveText(
    `starts at ${WORKSPACE} — the build session for Flow App`,
  );
  await page.click('#workspace-save');
  await expect(page.locator('#workspace-name-error')).toHaveText('name is required');
  expect(posts.filter(p => p === '/api/workspaces')).toEqual([]);
  await page.fill('wa-input#workspace-name input', 'flow build');
  await page.click('#workspace-save');

  // The row is the app's, at the ROOT cwd (the suite default), and the
  // auto-opened agent tab went live.
  const flowRow = page.locator('workspace-sidebar wa-tree-item[data-ws][selected]');
  await expect(flowRow).toContainText('flow build');
  await expect(flowRow.locator('.d')).toHaveText(WORKSPACE);
  const agentTab = await page.locator('terminal-tabs wa-tab').getAttribute('data-term');
  await expect(page.locator(`terminal-tabs .tab[data-term="${agentTab}"]`)).toHaveAttribute(
    'aria-label',
    /\(live\)/,
    {
      timeout: 10_000,
    },
  );
  await waitForTermText(page, AGENT_MARKER, 20_000);

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
  await page.waitForFunction(() => document.querySelectorAll('terminal-tabs wa-tab').length === 2);
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

  // Deleting the workspace (existing semantics), then the app, cleans up.
  await page.locator('workspace-sidebar wa-tree-item[data-ws][selected] [data-del-ws]').click();
  await page.click('#confirm-delete-ok');
  await expect(
    page.locator('workspace-sidebar wa-tree-item[data-ws]').filter({ hasText: 'flow build' }),
  ).toHaveCount(0);
  await page.locator('workspace-sidebar .ws-group[data-group="flow-app"] [data-del-app]').click();
  await expect(page.locator('#confirm-delete-text')).toContainText('Flow App');
  await page.click('#confirm-delete-ok');
  await expect(page.locator('workspace-sidebar .ws-group[data-group="flow-app"]')).toHaveCount(0);
});

test('deep links route by owner: app tabs bounce to /builder, console tabs to /', async ({
  page,
}) => {
  await login(page);
  await sweepFlowApp();
  // One terminal of each owner, through the API (the fixture's proj is an
  // app workspace; scratch's is a console one).
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

  // /?t=<app tab> redirects client-side to /builder?t=… and selects it.
  await page.goto(`/?t=${appTerm}`);
  await page.waitForURL(u => u.pathname === '/builder' && u.searchParams.get('t') === appTerm);
  await expect(page.locator(`workspace-sidebar wa-tree-item[data-ws="${appWs!.id}"]`)).toHaveAttribute('selected');
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
  await expect(page.locator(`workspace-sidebar wa-tree-item[data-ws="${consoleWs!.id}"]`)).toHaveAttribute('selected');

  // Job runs are orchestration: /builder?run= goes home.
  await page.goto('/builder?run=j-itest-run');
  await page.waitForURL(u => u.pathname === '/' && u.searchParams.get('run') === 'j-itest-run');
});

test('nav groups collapse per app: rows hide, state survives poll re-render + reload, aria-expanded tracks it', async ({
  page,
}) => {
  await login(page);
  await sweepFlowApp();
  await refreshState(page);
  // The group is a wa-tree-item: it toggles in place, and
  // `expanded` / aria-expanded reflect the state.
  const app = page.locator('workspace-sidebar .ws-group[data-group="alpha-app"]');
  // Leaf selection: clicking a group's own label toggles it.
  const expander = app.locator('.g-name');
  const row = app.locator('wa-tree-item[data-ws]');

  await expect(app).toHaveAttribute('aria-expanded', 'true');
  await expect(row).toBeVisible();

  // Collapsing hides the rows; the header (with + workspace) stays.
  await expander.click();
  await expect(app).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toBeHidden();
  await expect(app.locator('.g-name')).toHaveText('alpha app');

  const stored = await page.evaluate(() => localStorage.getItem('cybermole:nav-collapsed'));
  const collapsedMap = JSON.parse(stored ?? '{}') as Record<string, boolean>;
  expect(collapsedMap['alpha-app']).toBe(true);

  // A poll re-render keeps it collapsed.
  await refreshState(page);
  await expect(app).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toBeHidden();

  // The header's actions act without toggling the group.
  await app.locator('[data-new-ws]').click();
  await expect(page.locator('wa-input#workspace-name input')).toBeVisible();
  await page.locator('#workspace-dialog wa-button[data-dialog="close"]').click();
  await expect(app).toHaveAttribute('aria-expanded', 'false');

  await page.reload();
  await page.waitForSelector('workspace-sidebar .nav');
  await expect(app).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toBeHidden();

  // A filter forces groups open without touching stored state.
  const search = page.locator('wa-input#workspace-search input');
  await search.fill('proj');
  await expect(row).toBeVisible();
  await expect(app).toHaveAttribute('aria-expanded', 'true');
  await search.fill('');
  await expect(app).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toBeHidden();

  // Expand with the keyboard (the tree's ArrowRight); it persists.
  await app.focus();
  await page.keyboard.press('ArrowRight');
  await expect(app).toHaveAttribute('aria-expanded', 'true');
  await expect(row).toBeVisible();
  await expect
    .poll(async () => {
      const raw = await page.evaluate(() => localStorage.getItem('cybermole:nav-collapsed'));
      return (JSON.parse(raw ?? '{}') as Record<string, boolean>)['alpha-app'];
    })
    .toBeUndefined();
});
