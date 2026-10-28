# a cybermole app, scaffolded

This tree is a cybermole app (the image's app-starter
template, baked by the `cybermole-apps` scaffold): an Astro SSR webapp on
`@cybermole/app-kit`, served by the cybermole app host at `/apps/<slug>/`
behind the console's login once it is registered and built.

- `src/routes.ts` — THE route table: every action is one entry, bound by
  the kit to the HTTP route (`src/pages/api/[...path].ts`), the typed
  client the components' stores use, the MCP shim's tools and
  `dist/route-table.json` (emitted by the build — `astro.config.mjs`'s
  emit integration).
- `src/components/*.ts` — HTML web component enhancers: the element wraps
  the page's SSR'd light-DOM children and wires them from
  `connectedCallback` — enhance, never render (CODE_STYLE.md §7). Element
  names are `<slug>-<thing>` (unique per install; after scaffold, e.g.
  `<__APP_SLUG__-ping>`); `ping.ts` is the worked example.
- `src/store/*.ts` — the signals stores (`@preact/signals-core`):
  module-scoped live client state, refreshed through the typed route
  client — the same route table the API serves.
- `src/lib/` — the app's domain code (one Result family per concern);
  `data/` — the app's own sqlite (gitignored).
- `scripts/setup-node-modules.mjs` — the per-package node_modules symlinks
  into the install's tree (re-run after an image upgrade).
- `scripts/check-selfcontained.mjs` — the §5 build gate; `npm run build`
  runs it (the built entry must import nothing but node: builtins and
  relative chunks).

## The loop

```sh
npm run setup     # once (and after image upgrades): link the core stack
npm run check     # THE gate: astro check + tsc + lint:arch + unit tests + build
npm run build     # the build half alone (route-table.json + self-containment gate)
npm run test      # just the unit tests
npm run test:e2e  # the browser half: Playwright over the BUILT app (below)
```

The `lint:arch` stage is the architecture lint
(`@cybermole/app-kit`'s `arch-check.mjs`): the component standard's
mechanical rules — no preact renderer (only `@preact/signals-core`), no
`attachShadow`, no `innerHTML`/`outerHTML` writes, element defines only
through the kit's `defineElement`.

The same loop runs through the root agent's `cybermole-apps` MCP
(`add_action`/`check`/`build`/`register`/`reload`) — this tree's `.pi/mcp.json`
disables that MCP on purpose (operators don't scaffold) and registers the
app's own action tools under the app's slug: the shim binary
(`<install>/dist-server/server/app-mcp-shim.js <slug>`), its tools 1:1 with
`dist/route-table.json`.

`AGENTS.md` in this tree is the operator's manual for agents working
here — read it first.

## End-to-end tests (`npm run test:e2e`)

Separate from `npm run check` on purpose: the gate stays fast and
offline-safe, while e2e proves the BUILT app in a real browser. The
console's own hermetic Playwright pattern, app-side: the kit's harness
(`@cybermole/app-kit/testing`) boots this tree's `dist/server/entry.mjs`
(the handler the app host mounts) on an ephemeral loopback server with a
throwaway data dir — the tree's real `data/` is never touched
(`CYBERMOLE_APP_DATA_DIR`, honored by the kit's `appDataDir()`).
`playwright.config.ts` is two lines on the kit's factory; each spec starts
from `createAppTest(import.meta.url)` and navigates with `app.baseURL`.

- **when to run it**: whenever page-level behavior changed — enhancer
  elements wiring up, forms, navigation — before handing the change over.
  The unit tests cover the actions; this covers the loop between them.
- needs Playwright's chromium; when it isn't installed the run fails with
  one clear message instead of a stack trace (`npx playwright install
  chromium` on a networked host; in fleet sandboxes the browser cache is
  host-mounted — ask the host to install once).
- the harness mounts the app's own handler only: no console login, no
  session gate, no WS tunnel — those faces stay with the console's own
  `apps-*` specs. HTTP only; an app's optional `ws.mjs` entry is not
  mounted.

## The agent drawer

Every scaffolded app ships the drawer: the page embeds
`<agent-console slug="__APP_SLUG__"></agent-console>` and its client
script imports `@cybermole/app-kit/agent-console` (both already in
`src/pages/index.astro` — keep them on new pages, or drop them
deliberately). It is the app's operator console:

- the **agent** button (fixed, bottom-end) opens a drawer with ONE
  terminal — this app's operator workspace's agent tab. The workspace
  (kind NULL, cwd = this tree) is created on first open through
  `POST /api/workspaces {appId}`; a dead session respawns at the tree;
  closing the drawer detaches (the tmux session keeps running).
- the **builder** link beside it deep-links to `/builder?t=<this app's
  first build workspace's first terminal>` — plain `/builder` when the
  app has no build session yet.

The drawer talks to the console same-origin (`/api/*`, `/ws`) with the
session cookie — apps get terminal powers, not console powers; the
frame is advisory. Keep it as-is; apps don't reimplement it.

## WebSocket routes

An app can serve live sockets at its own paths: a page (or any same-origin
client) dials `new WebSocket('/apps/<slug>/<path>')`. The console gates the
upgrade — valid session, same Origin, per-IP rate limit — strips the session
cookie (apps get a terminal's powers, not the console's) and tunnels the
socket to the app host, which hands the upgrade to the app's optional **WS
entry**. An app without one answers 404 on every upgrade, like an unrouted
HTTP path.

The contract:

- **The WS entry is `dist/server/ws.mjs`**, plain ESM exporting
  `handleUpgrade(req, socket, head)` — the `ws` package's
  `WebSocketServer({ noServer: true })` shape. It may import `node:` builtins
  and `ws` (linked into `node_modules` by `scripts/setup-node-modules.mjs`);
  it sits outside the `entry.mjs` self-containment graph on purpose, so keep
  domain logic in `src/lib` and reach it over HTTP actions.
- **Emit it from your build**: `writeWsEntry(appRoot)` from
  `@cybermole/app-kit/route-table-emit` in an `astro:build:done` hook copies
  `src/ws.mjs` when present (a no-op otherwise, so the hook can ship in every
tree).
- **Paths arrive verbatim with the baked base** (`/apps/<slug>/…`), queries
  included — route them yourself and destroy unknowns.
- **Lifecycle**: the host never pings and a quiet tunnel stays up, but
  logout, token expiry and shutdown cut tunnels without a close handshake —
  clients must reconnect, not assume.

The whole pattern (this is the complete example — an echo server at
`/apps/<slug>/ws`):

```js
// src/ws.mjs — the app's WS entry (copied verbatim into dist/server/ by the
// build's writeWsEntry hook).
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

export function handleUpgrade(req, socket, head) {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/apps/<slug>/ws') {
    // The app is the router: unknown paths refuse, never hang.
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('message', data => ws.send(data.toString())); // echo, as text
  });
}
```

```js
// astro.config.mjs — the emission hook, next to emitRouteTable.
import { writeWsEntry } from '@cybermole/app-kit/route-table-emit';

const emitWsEntry = () => ({
  name: 'emit-ws-entry',
  hooks: { 'astro:build:done': () => writeWsEntry(appRoot) },
});
// … integrations: [lit(), emitRouteTable(), emitWsEntry()],
```

The browser half is an ordinary same-origin dial from a page or enhancer —
with the usual `onopen`/`onmessage`/`onclose` handling; nothing about
the proxy is visible to the client:

```js
// In an enhancer (or page script): the baked base carries no trailing
// slash — the kit's route client joins paths the same way.
const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
const ws = new WebSocket(`${location.origin}${base}/ws`);
ws.onmessage = e => console.log('echo:', e.data);
```

`check` gates the entry like any other file (the build must emit it), and
`register` + `reload` mount it; a rebuild plus `reload` re-imports a changed
entry.
