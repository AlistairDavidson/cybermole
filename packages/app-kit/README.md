# @cybermole/app-kit

The shared half of cybermole — what apps (and the console) are built on
(docs/apps-plan.md §5). Ships **source**, no build step: astro/vite
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
  error codes (docs/CODE_STYLE.md §1).
- **`types/branded`** — branded-ID helpers (`JobName`, `AppSlug`, … and
  their `as*()` trust-boundary casts).
- **`schemas/patterns` + `schemas/ids`** — the node-free zod schema layer:
  ID regexes (`JOB_NAME_RE`, …), normalizers (`normalizeSlug`, …) and the
  validating, branding schemas built on them.
- **`web/responses.service`** — the generic Result→HTTP mapping
  (`jsonResponse`, `successResponse`, `firstIssueText`,
  `validationFailureResponse`). The console's domain mappers stay in the
  console.
- **`db/sqlite`** — the node:sqlite helper pattern: `SqliteDb` (lazy open,
  PRAGMAs, schema+migrate+version at open, cached statements, typed
  `all/get/run`), `createQb()` (compile-only Kysely query builder), and
  the `databaseRead`/`databaseUpdate` boundary Results.
- **`storage`** — the S3-compatible object-storage client (`ObjectStore`,
  the store/stat/fetch families) with a `setStorageLogger()` seam.
- **`route-table`** — the binder: `defineRoute()` + `handleApiRequest()` /
  `astroApiHandlers()`, `toMcpToolShapes()`, `createRouteClient()`,
  `serializeRouteTable()` (see the module header for the whole shape).

Subpath exports (client/vite code only — the runtime manifest maps just
the root):

- **`@cybermole/app-kit/wa-client`** — the wa-* client-import boilerplate;
  import it FIRST in any client script that uses SSR'd wa-* components.
- **`@cybermole/app-kit/island`** — `mountIsland()`, the preact-signals
  island convention.
- **`@cybermole/app-kit/route-table`** / **`route-table-emit`** — the
  node-free binder core, and `writeRouteTable()` for the app's build
  (dist/route-table.json).

## Deferred

The internal-API socket client helper (plan §5's jobs-facing piece) is
deliberately absent: `server/mcp.ts`'s socket client stays put until
task/app-host (branch 1) lands `src/lib/internal-api-client.ts`, which
will be the kit helper's base.
