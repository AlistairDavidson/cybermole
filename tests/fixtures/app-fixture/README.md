# app-fixture — the apps-plan branch-1 fixture

A REAL minimal Astro app (SSR + Web Awesome + one Result-JSON API route)
for running the **app host** (`server/app-host.ts`) by hand. It is
vendored fixture code: built by its own toolchain, excluded from the
repo's astro check / eslint / prettier (see the one-line "fixture app"
entries in `tsconfig.json`, `eslint.config.mjs`, `.prettierignore`).

Layout: the app's future shape per docs/apps-plan.md §2 — `app.json`
(manifest), `astro.config.mjs` (base `/apps/app-fixture` BAKED, node
adapter middleware mode), `src/pages` (one SSR page proving the DSD
pipeline), `src/pages/api` (one hand-rolled Result-JSON route — the
kit's route-table binder replaces this in a later branch),
`src/vendor/` (the inlinable astro-lit SSR renderer copy — see
"self-containment" below).

## node_modules: per-package symlinks (plan §5's shape)

```sh
node setup-node-modules.mjs      # from THIS directory
```

creates `node_modules/<pkg>` as per-package symlinks into the repo's
`node_modules` (astro, @astrojs/node, @awesome.me/webawesome,
@awesome.me/astro-lit, lit, lit-element, zod, the @lit-labs shims, plus
the `astro` bin). Node resolves each link to its real path before
looking up transitive deps, so the whole stack resolves through the
repo's tree with zero registry access. A whole-dir link is the WRONG
shape: an app installing an extra would replace it and orphan the core
stack — extras install alongside the per-package links, which is the
image's contract (`packages/` extraction and the scaffold formalize this
in later branches).

## Build + the self-containment gate (plan §5, load-bearing)

```sh
./node_modules/.bin/astro build
node ../../../tools/check-app-selfcontained.mjs dist/server/entry.mjs
```

The build must be **self-contained apart from `node:` builtins**: every
non-relative import reachable from `dist/server/entry.mjs` inlines into
`dist/`, so serve-time (the app host importing the entry) never resolves
through a node_modules symlink an app's extra install could disturb.
This is pinned by (see `astro.config.mjs`):

- `vite.ssr.noExternal: true` — inlines everything inlinable (astro,
  lit, zod, …; `node:` stays external);
- `resolve.alias` of `@awesome.me/astro-lit/server.js` → the vendored,
  bundle-friendly copy in `src/vendor/` (the integration force-
  externalizes its own entrypoint, and as shipped it `readFileSync`s its
  package.json relative to its module URL, so it cannot be bundled);
  `lit-element` / `lit/decorators.js` / `@lit-labs/ssr` alias through
  the app's own links to defeat that external list;
- hashed `chunkFileNames` — a rebuild changes a chunk's content hash, so
  the stable-named entry references NEW paths and the host's
  cache-busted re-import picks the new build up whole.

Size as of branch 1: the reachable graph is ~1.7 MiB / 18 modules
(entry.mjs ~830 KiB) — astro's SSR runtime plus the lit renderer,
inlined once per app build.

The vendored renderer copy is byte-identical to
`node_modules/@awesome.me/astro-lit/server{,-shim}.js` except: the
self-read of package.json is replaced by the literal package name, the
shim import points at the local shim copy, and the shim's
`customElements.define` patch is applied once and made idempotent (the
host's cache-busted RE-import re-runs module-level defines against the
process's one registry — a duplicate `wa-card` would throw and break
every rebuild+reload). The app-kit branch ships a compiled renderer and
the vendored copies go away.

## Run the host against it, by hand

The host discovers apps through the INTERNAL API (`CYBERMOLE_SOCK`) and
listens on its own socket (`CYBERMOLE_APPS_SOCK`). Both sockets can live
in a scratch dir; nothing needs root or /run.

```sh
# 1. a scratch state dir + the internal socket the host will discover over
export W=/tmp/cybermole-app-host-demo
mkdir -p "$W"

# 2. the app row: through the console (Settings → app group), or straight
#    into the state db with sqlite:
node -e "
  const { StateDb } = require('./dist-server/src/lib/db.js');
  const { Apps } = require('./dist-server/src/lib/apps.js');
  const db = new StateDb('$W/cybermole.db');
  const apps = new Apps({ db, username: () => ({ ok: true, data: { value: 'demo' } }), killSession: async () => true });
  apps.saveApp('App Fixture', process.cwd() + '/tests/fixtures/app-fixture').then(r =>
    console.log(r.ok ? 'row created: ' + r.data.slug : 'failed: ' + r.errorMessage));
"

# 3. the host (the internal API is served by the web server; for a
#    standalone demo boot one — main.js with its sockets pointed at $W,
#    or reuse the unit-test fixture shape)
CYBERMOLE_APPS_SOCK="$W/apps.sock" node dist-server/server/app-host.js

# 4. poke it (registration/rebuild → reload is THE sync point)
curl --unix-socket "$W/apps.sock" -X POST http://localhost/_admin/reload -d '{}'
curl --unix-socket "$W/apps.sock" http://localhost/_admin/status

# 5. the app, through the socket
curl --unix-socket "$W/apps.sock" http://localhost/apps/app-fixture/
curl --unix-socket "$W/apps.sock" 'http://localhost/apps/app-fixture/api/ping?name=world'
```

Step 3 needs a live internal API to discover rows (the host retries
with backoff until it answers — the compose boot race). The quickest
standalone shape is a scratch `server/main.js` boot with
`CYBERMOLE_STATE_DIR="$W"` and `CYBERMOLE_SOCK="$W/cybermole.sock"` (set
a password first: `npm run set-password`), or crib the internal-api +
app-host pair from `tests/unit/app-host.test.mjs`'s `bootWorld()`.

Expect: `/_admin/status` lists the mount (`slug app-fixture, base
/apps/app-fixture`); the page answers 200 HTML with declarative shadow
DOM (`shadowrootmode` attributes); the API answers
`{"ok":true,"resultType":"ping",...}`; hashed `_astro/` assets answer
with `cache-control: public, max-age=3600`. Break something (delete
`app.json`, break the build) and reload — the app shows up in
`status.skipped` with the reason, and the host keeps serving everything
else.
