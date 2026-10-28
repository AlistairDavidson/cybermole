# @cybermole/app-kit

The shared half of cybermole — what apps (and the console) are built on. Ships **source**, no build step: astro/vite
compiles it through the workspace symlink (`vite.ssr.noExternal` for SSR
builds), and the console's server tsc compiles it in place — the emitted
files land in `dist-server/packages/app-kit/`, with the runtime manifest
`tools/place-kit-manifest.mjs` places so serve-time never resolves through
the source symlink.

## The public surface (root import: `@cybermole/app-kit`)

Everything below comes from the root entry — the one specifier
server-compiled code uses:

- **`types/result`** — the Result family (`Result`, `ResultSuccess`,
  `ResultFailure`): `{ ok, resultType, data }` / `{ ok: false, resultType,
  errorCode, errorMessage?, issues? }`, one family per concern, closed
  error codes (docs/conventions/CODE_STYLE.md §1).
- **`types/branded`** — branded-ID helpers (`JobName`, `AppSlug`, … and
  their `as*()` trust-boundary casts).
- **`schemas/patterns` + `schemas/ids`** — the node-free zod schema layer:
  ID regexes (`JOB_NAME_RE`, …), normalizers (`normalizeSlug`, …) and the
  validating, branding schemas built on them.
- **`terminal-protocol`** — the terminal WS wire protocol (`ClientMsg`,
  `ServerMsg`, `ActiveKey`, `parseClientMsg`/`parseBackfillMsg`): one
  definition shared by the console's rich terminal client, the app
  pages' drawer client, and the server's frame gate.
- **`web/responses.service`** — the generic Result→HTTP mapping
  (`jsonResponse`, `successResponse`, `firstIssueText`,
  `validationFailureResponse`). The console's domain mappers stay in the
  console.
- **`db/sqlite`** — the node:sqlite helper pattern: `SqliteDb` (lazy open,
  PRAGMAs, schema+migrate+version at open, cached statements, typed
  `all/get/run`), `createQb()` (compile-only Kysely query builder), and
  the `databaseRead`/`databaseUpdate` boundary Results.
- **`app-data`** — the app-tree conventions: `appRootFrom(from)` (the
  nearest ancestor holding app.json — `from` is any file in the tree,
  `import.meta.url` from src/ and the built chunks alike) and
  `appDataDir(from)` (the app's gitignored `data/`), overridable wholesale
  with `CYBERMOLE_APP_DATA_DIR` — the e2e harness's hermeticity seam.
- **`storage`** — the S3-compatible object-storage client (`ObjectStore`,
  the store/stat/fetch families) with a `setStorageLogger()` seam.
- **`route-table`** — the binder: `defineRoute()` + `handleApiRequest()` /
  `astroApiHandlers()`, `toMcpToolShapes()`, `createRouteClient()`,
  `serializeRouteTable()` (see the module header for the whole shape).

Subpath exports (client/vite code only — the runtime manifest maps just
the root):

- **`@cybermole/app-kit/wa-client`** — the wa-* client-import boilerplate;
  import it FIRST in any client script that uses SSR'd wa-* components.
- **`@cybermole/app-kit/element`** — the HTML web component convention:
  `defineElement(name, setup)` (guard + connect/disconnect lifecycle, the
  returned teardown runs on disconnect) and `waValue()` for reading an
  un-upgraded-or-not wa-* control. Enhance, never render (CODE_STYLE.md §7).
- **`@cybermole/app-kit/live`** — `createAppSocket()`: the WS doorbell
  client (zod-validated frames, capped-backoff reconnect) + `backoffDelay()`.
- **`scripts/arch-check.mjs`** (not an export — run it with node) — the
  architecture lint: §7's mechanical rules; the module's header comment is
  the rule list. An app's `lint:arch` script runs it over `src` +
  `astro.config.mjs`.
- **`@cybermole/app-kit/agent-console`** — the app pages' agent drawer
  (`<agent-console slug=…>`): the wa-drawer + ONE lean xterm over the
  console's /ws bridge, the operator-workspace open flow and the builder
  deep link (see the app-starter README § The agent drawer). Imports the
  theme tokens + its wa-* halves itself; pulls `@xterm/xterm` and
  `@xterm/addon-fit` (declared as kit dependencies — apps link them via
  `scripts/setup-node-modules.mjs`).
- **`@cybermole/app-kit/route-table`** / **`route-table-emit`** — the
  node-free binder core, and `writeRouteTable()` for the app's build
  (dist/route-table.json) plus `writeWsEntry()` (the optional
  dist/server/ws.mjs WS entry — see the app-starter README's § WebSocket
  routes for the whole contract).
- **`@cybermole/app-kit/testing`** — the per-app e2e harness, the
  app-side twin of the console's hermetic Playwright pattern:
  `startAppServer({ appRoot, dir? })` boots the tree's BUILT
  `dist/server/entry.mjs` (the @astrojs/node middleware handler the app
  host mounts — client files first, then the handler, the host's security
  headers included) on an ephemeral loopback HTTP server and answers
  `{ baseURL, origin, base, dir, close() }`; `dir` is a per-run temp dir
  whose `data/` the app is pointed at through `CYBERMOLE_APP_DATA_DIR`
  (`appDataDir`), so a run never touches the tree's real data. The
  Playwright glue: `appPlaywrightConfig()` (an app's whole
  playwright.config.ts) and `createAppTest(import.meta.url)` (a `test`
  with a worker-scoped `app` fixture). Needs `@playwright/test` (peer
  dep); the config's global setup fails loud and clean when chromium
  isn't installed, and builds the tree when dist/ is missing. HTTP only —
  an app's optional WS entry is not mounted. NOT part of `npm run check`:
  apps wire their own `test:e2e` script (the app-starter template ships
  the shape; runtime/reference-apps/notes the worked example).

## Deferred

The internal-API socket client helper (plan §5's jobs-facing piece) is
deliberately absent: `server/mcp.ts`'s socket client stays put until
task/app-host (branch 1) lands `src/lib/internal-api-client.ts`, which
will be the kit helper's base.
