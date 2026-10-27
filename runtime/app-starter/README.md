# a cybermole app, scaffolded

This tree is a cybermole app (the image's app-starter
template, baked by the `cybermole-apps` scaffold): an Astro SSR webapp on
`@cybermole/app-kit`, served by the cybermole app host at `/apps/<slug>/`
behind the console's login once it is registered and built.

- `src/routes.ts` — THE route table: every action is one entry, bound by
  the kit to the HTTP route (`src/pages/api/[...path].ts`), the typed
  client the island uses, the MCP shim's tools and `dist/route-table.json`
  (emitted by the build — `astro.config.mjs`'s emit integration).
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
npm run check     # THE gate: astro check + tsc + unit tests + build
npm run build     # the build half alone (route-table.json + self-containment gate)
npm run test      # just the unit tests
```

The same loop runs through the root agent's `cybermole-apps` MCP
(`add_action`/`check`/`build`/`register`/`reload`) — this tree's `.pi/mcp.json`
disables that MCP on purpose (operators don't scaffold) and registers the
app's own action tools under the app's slug: the shim binary
(`<install>/dist-server/server/app-mcp-shim.js <slug>`), its tools 1:1 with
`dist/route-table.json`.

`AGENTS.md` in this tree is the operator's manual for agents working
here — read it first.

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

The browser half is an ordinary same-origin dial from a page or island —
with the usual `onopen`/`onmessage`/`onclose` handling; nothing about
the proxy is visible to the client:

```js
// In an island (or page script): the baked base carries no trailing
// slash — the kit's route client joins paths the same way.
const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
const ws = new WebSocket(`${location.origin}${base}/ws`);
ws.onmessage = e => console.log('echo:', e.data);
```

`check` gates the entry like any other file (the build must emit it), and
`register` + `reload` mount it; a rebuild plus `reload` re-imports a changed
entry.
