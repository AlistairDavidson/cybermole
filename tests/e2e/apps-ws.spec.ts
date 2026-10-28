// The apps WS surface end to end, through the shared webServer's whole
// stack: the scaffolded template grown a ws entry (the app-starter README's
// § WebSocket routes recipe, its frames typed per the doorbell contract),
// checked green, registered and reloaded — then a page in the console
// origin has its store dial a WebSocket to its own /apps/<slug>/… endpoint
// through browser → session gate → /apps WS tunnel → app host unix socket →
// the app's ws entry and back, the <slug>-echo component rendering the log.
// The rejection face too: without a session the upgrade dies (401), and an
// app-side unrouted path 404s (the app is the router).
//
// Apps-spec discipline: see apps-notes.spec.ts (shared cookie via env.ts,
// marker-gated entry sweep, no afterAll teardown, idempotent per-test
// preconditions).
import { expect, test } from '@playwright/test';
import type { Cookie, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APPS_ROOT,
  APPS_SOCKET,
  INTERNAL_SOCKET,
  PASSWORD,
  USERNAME,
  readSharedSessionCookie,
  writeSharedSessionCookie,
} from '../support/env';
import {
  registerTool,
  reloadTool,
  statusTool,
  unregisterTool,
} from '../../dist-server/server/apps-mcp.js';
import { runChild } from '../../dist-server/src/lib/apps/apps-child.js';
import { scaffoldApp } from '../../dist-server/src/lib/apps/apps-scaffold.js';
import { checkApp } from '../../dist-server/src/lib/apps/apps-gate.js';

const REPO = path.resolve(__dirname, '..', '..');
const SLUG = 'ws-echo';
/** Inside APPS_ROOT, so the per-run WORKSPACE rm makes it run-scoped. */
const SWEEP_MARKER = path.join(APPS_ROOT, `.${SLUG}.swept`);
/** Resolved like main() would, against this suite's sockets and apps root. */
const deps = {
  appsRoot: APPS_ROOT,
  internalSocketPath: INTERNAL_SOCKET,
  appsSocketPath: APPS_SOCKET,
  installRoot: REPO,
};

// dist-server ships no .d.ts, so tool answers are loose JSON here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed tool JSON
type Json = any;

async function tool(
  run: Promise<{ isError?: boolean; content?: Array<{ text?: string }> } | undefined>,
): Promise<{ isError: boolean; body: Json }> {
  const r = await run;
  return { isError: r?.isError === true, body: JSON.parse(r?.content?.[0]?.text ?? '{}') };
}

/** Signs in once per run: the shared cookie file first, a form sign-in
 *  only if nobody has yet (the apps specs share the login budget). */
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

test.beforeAll(async () => {
  // Entry sweep, gated once per run by the marker (see apps-notes.spec.ts).
  if (fs.existsSync(SWEEP_MARKER)) return;
  fs.mkdirSync(APPS_ROOT, { recursive: true });
  fs.writeFileSync(SWEEP_MARKER, `${process.pid} ${Date.now()}\n`);
  fs.rmSync(path.join(APPS_ROOT, SLUG), { recursive: true, force: true });
  try {
    await unregisterTool(deps, SLUG);
  } catch {
    /* no row */
  }
});

// ---------- the README recipe, applied to a fresh scaffold ----------

/** The ws entry from the app-starter README, with this slug baked. */
function wsEntrySource(): string {
  return [
    "// The app's WS entry (emitted into dist/server/ by writeWsEntry).",
    "import { WebSocketServer } from 'ws';",
    '',
    'const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });',
    '',
    'export function handleUpgrade(req, socket, head) {',
    "  const path = (req.url ?? '').split('?')[0];",
    `  if (path !== '/apps/${SLUG}/ws') {`,
    '    // The app is the router: unknown paths refuse, never hang.',
    "    socket.write('HTTP/1.1 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n');",
    '    socket.destroy();',
    '    return;',
    '  }',
  ].join('\n');
}

/** The echo store: dials the app's own /apps/<slug>/ws (the doorbell
 *  client — typed frames, reconnect) and keeps the log signal the enhancer
 *  renders. No route client: this is a raw echo socket, not an action. */
const ECHO_STORE = `import { signal } from '@preact/signals-core';
import { z } from 'zod';
import { createAppSocket } from '@cybermole/app-kit/live';

export const echoLog = signal('dialing');

const line = (text: string): void => {
  echoLog.value = \`\${echoLog.value} | \${text}\`;
};

const base = import.meta.env.BASE_URL.replace(/\\/+$/, '');
createAppSocket({
  url: () => \`\${location.origin}\${base}/ws\`,
  frame: z.object({ type: z.string() }),
  onOpen: () => line('open'),
  onFrame: (frame: { type: string }) => line(\`echo: \${frame.type}\`),
});
`;

/** The echo component's SSR half: the aria-live line is server-rendered
 *  (native elements, so the component owns no wa-* halves). */
const ECHO_ASTRO = `---
// The echo element's UI (SSR): the ${SLUG}-echo host with its live log
// line. The enhancer (echo.ts, this directory) wires it; the store
// (src/store/echo.ts) holds the live state.
---
<${SLUG}-echo>
  <p class="ws-status" aria-live="polite">dialing</p>
</${SLUG}-echo>
`;

/** The echo component's enhancer half: the effect is the only thing that
 *  touches the SSR'd line. */
const ECHO_ENHANCER = `import { effect } from '@preact/signals-core';
import { defineElement } from '@cybermole/app-kit/element';
import { echoLog } from '../../store/echo';

defineElement('${SLUG}-echo', host => {
  const out = host.querySelector('p[aria-live]');
  return effect(() => {
    if (out !== null) out.textContent = echoLog.value;
  });
});
`;

test('the README recipe: scaffold → grow a ws entry → check green → register + reload', async ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the fixture is the point: a uniform signature per file (one worker)
  page: _page,
}) => {
  test.setTimeout(240_000);

  const tree = path.join(APPS_ROOT, SLUG);
  if (!fs.existsSync(path.join(tree, 'app.json'))) {
    const scaffolded: Json = await scaffoldApp(
      {
        appsRoot: APPS_ROOT,
        templateDir: path.join(REPO, 'runtime', 'app-starter'),
        agentTemplateFile: path.join(REPO, 'runtime', 'app-agents', 'AGENTS.md'),
        installRoot: REPO,
        run: runChild,
      },
      { name: 'WS Echo', description: 'the ws-echo fixture app' },
    );
    expect(scaffolded.ok, JSON.stringify(scaffolded)).toBe(true);
    if (!scaffolded.ok) return;
    expect(scaffolded.data).toMatchObject({ slug: SLUG, linked: true, committed: true });
  } else {
    // A replacement worker re-ran this file: the tree is already grown.
    expect(fs.existsSync(path.join(tree, 'src', 'ws.mjs'))).toBe(true);
  }

  if (!fs.existsSync(path.join(tree, 'src', 'ws.mjs'))) {
    // The ws entry: the README's example, this tree's slug baked in, plus
    // the greeting frame and echo the store exercises.
    fs.writeFileSync(
      path.join(tree, 'src', 'ws.mjs'),
      `${wsEntrySource()}
  wss.handleUpgrade(req, socket, head, ws => {
    // The doorbell contract: frames are small typed JSON events. This entry
    // greets on connect, then echoes every message back as a frame.
    ws.send(JSON.stringify({ type: 'hello through the tunnel' }));
    ws.on('message', data => ws.send(JSON.stringify({ type: data.toString() })));
  });
}
`,
    );
    // The store dials from the page; the component directory renders the
    // log line (SSR .astro + enhancer).
    fs.mkdirSync(path.join(tree, 'src', 'store'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'src', 'store', 'echo.ts'), ECHO_STORE);
    fs.mkdirSync(path.join(tree, 'src', 'components', 'Echo'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'src', 'components', 'Echo', 'Echo.astro'), ECHO_ASTRO);
    fs.writeFileSync(path.join(tree, 'src', 'components', 'Echo', 'echo.ts'), ECHO_ENHANCER);
    // The page hosting it (outside the template's generated markers).
    fs.writeFileSync(
      path.join(tree, 'src', 'pages', 'ws.astro'),
      `---
// The page owns its page-level wa-* halves (the card); the component owns
// its own — here none, the echo element is native elements.
import '@awesome.me/webawesome/dist/components/card/card.js';
import Echo from '../components/Echo/Echo.astro';
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WS Echo</title>
  </head>
  <body>
    <main style="font-family: system-ui; max-width: 40rem; margin: 3rem auto; padding: 0 1rem;">
      <wa-card>
        <h1 slot="header">WS Echo</h1>
        <Echo />
      </wa-card>
    </main>
    <script>
      // The page's own wa-* halves (the card); the component imports its own.
      import '@cybermole/app-kit/wa-client';
      import '@awesome.me/webawesome/dist/components/card/card.js';
      import '../components/Echo/echo';
    </script>
  </body>
</html>
`,
    );
    // The build emits the entry: the README's emitWsEntry hook.
    const config = path.join(tree, 'astro.config.mjs');
    let text = fs.readFileSync(config, 'utf8');
    text = text.replace(
      "import { writeRouteTable } from '@cybermole/app-kit/route-table-emit';",
      "import { writeRouteTable, writeWsEntry } from '@cybermole/app-kit/route-table-emit';",
    );
    text = text.replace(
      'export default defineConfig({',
      `const emitWsEntry = () => ({
  name: 'emit-ws-entry',
  hooks: {
    'astro:build:done': () => {
      writeWsEntry(appRoot);
    },
  },
});

export default defineConfig({`,
    );
    text = text.replace(
      'integrations: [lit(), emitRouteTable()],',
      'integrations: [lit(), emitRouteTable(), emitWsEntry()],',
    );
    fs.writeFileSync(config, text);
  }

  // The gate: typecheck, the tree's unit tests, and the build (which now
  // also emits dist/server/ws.mjs).
  const checked: Json = await checkApp({ appsRoot: APPS_ROOT, run: runChild }, SLUG);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  if (!checked.ok) return;
  expect(checked.data.envelope.passed, checked.data.envelope.output).toBe(true);
  expect(fs.existsSync(path.join(tree, 'dist', 'server', 'ws.mjs'))).toBe(true);

  const registered = await tool(registerTool(deps, SLUG));
  expect(
    !registered.isError || registered.body?.code === 'duplicate_slug',
    JSON.stringify(registered),
  ).toBe(true);
  const reloaded = await tool(reloadTool(deps, SLUG));
  expect(reloaded.isError, JSON.stringify(reloaded.body)).toBe(false);
  expect(
    [...(reloaded.body.mounted ?? []), ...(reloaded.body.reimported ?? [])],
    JSON.stringify(reloaded.body),
  ).toContain(SLUG);
});

/** Registered and mounted, re-established idempotently (see apps-notes.spec.ts). */
async function ensureRegisteredAndMounted(): Promise<void> {
  const status = await tool(statusTool(deps, SLUG));
  expect(status.isError, JSON.stringify(status.body)).toBe(false);
  const app = status.body.apps[0] as { registered?: boolean } | undefined;
  if (!app?.registered) {
    const registered = await tool(registerTool(deps, SLUG));
    expect(
      !registered.isError || registered.body?.code === 'duplicate_slug',
      JSON.stringify(registered),
    ).toBe(true);
  }
  const reloaded = await tool(reloadTool(deps, SLUG));
  expect(reloaded.isError, JSON.stringify(reloaded.body)).toBe(false);
  expect(
    [...(reloaded.body.mounted ?? []), ...(reloaded.body.reimported ?? [])],
    JSON.stringify(reloaded.body),
  ).toContain(SLUG);
}

/** An in-page dial: 'open' once the socket opens, 'closed' if it dies first. */
function dial(page: Page, url: string): Promise<'open' | 'closed'> {
  return page.evaluate(
    u =>
      new Promise<'open' | 'closed'>(resolve => {
        let opened = false;
        const ws = new WebSocket(u);
        ws.onopen = () => {
          opened = true;
          ws.close();
          resolve('open');
        };
        ws.onclose = () => resolve(opened ? 'open' : 'closed');
        ws.onerror = () => undefined;
      }),
    url,
  );
}

test('the use loop: a page echo round trip through the whole stack, and the app routes its own paths', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ensureRegisteredAndMounted();
  await login(page);

  await page.goto(`/apps/${SLUG}/ws`);
  await expect(page.locator('wa-card h1')).toHaveText('WS Echo');
  // The store dials on load (createAppSocket) and the app's greeting frame
  // comes back through the tunnel; the enhancer renders the log line.
  await expect(page.locator(`${SLUG}-echo p.ws-status`)).toHaveText(
    'dialing | open | echo: hello through the tunnel',
  );

  // The app is the router: an unrouted path under the same app refuses.
  expect(await dial(page, `/apps/${SLUG}/no-such-ws-route`)).toBe('closed');
});

test('no session: the upgrade dies (the gate, not the app, refuses)', async ({ page }) => {
  test.setTimeout(60_000);
  await ensureRegisteredAndMounted();
  // Deliberately not signed in: this context carries no session cookie.
  await page.goto('/login');
  expect(await dial(page, `/apps/${SLUG}/ws`)).toBe('closed');
});
