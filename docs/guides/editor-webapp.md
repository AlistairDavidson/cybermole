# The editor webapp — VSCodium reh-web, same-origin

The editor is **VSCodium's reh-web build** ("`codium serve-web`" —
self-hosted VS Code in the browser with server-side files), served through
cybermole's **same-origin `/editor` proxy** behind the session gate. It
replaced a Zed/KasmVNC attempt (streaming a desktop GUI was the poor fit —
separate basic auth, one instance, no per-folder URLs, a launcher
container); this document describes what shipped.

## Architecture

```
                browser (one origin, the console's)
      ┌──────────┴────────────────┐
      │ https://cybermole…/           │  /  (console)      /editor/?folder=…  (iframe)
      └──────────┬────────────────┘
        nginx TLS│ (one vhost — deploy/nginx/cybermole.conf; ws upgrades already mapped)
      ┌──────────┴───────────────────────────┐
      │ cybermole (uid node)                     │ server/main.ts
      │  origin check + session gate         │
      │  /editor/* ──HTTP stream + raw WS──┼─┼──▶ editor:3000 (compose network)
      │  per-token tunnel tracking          │ │
      └──────────┬───────────────────────────┘
                 │ same volume, same path
      ┌──────────┴──────────────────────┐   ┌─────────────────────────────┐
      │ workspace uid 2000              │   │ editor uid 2000             │
      │ tmux server + pi sessions       │   │ bin/codium-server (reh-web) │
      └──────────┬──────────────────────┘   │  /workspace  ← rw (shared)  │
                 └──────────────────────────┘  /home/workspace ← editor-home volume
```

Trust level: the editor's integrated terminal
is another web shell as **the same uid 2000** the terminal already gives
you. It sits behind the session gate like every other route — logout /
"log out everywhere" cut its sockets with the terminals (below). It never
touches the tmux socket or web state.

## The image (`deploy/editor/`)

A thin in-repo image: Debian bookworm-slim + the **pinned**
`vscodium-reh-web-linux-{x64,arm64}-<version>.tar.gz`
(sha256-verified at build, both hashes as `ARG`s) extracted intact to
`/opt/editor`. uid 2000 / gid 2001 (`workspace`/`cybermole`, the split's
users), umask 0007. The entrypoint runs the tarball's own
`bin/codium-server`:

```
--host 0.0.0.0 --port 3000 \
--server-base-path "${CYBERMOLE_BASE%/}/editor" \
--without-connection-token \
--disable-workspace-trust \
--telemetry-level off
```

- auth is upstream — cybermole's session gate; there is no connection token,
  no launcher, no token file.
- the base path interpolates from `CYBERMOLE_BASE` exactly like the cybermole
  service's, so asset URLs line up with the proxy.
- **workspace trust is off** (`--disable-workspace-trust` → the served
  workbench embeds `enableWorkspaceTrust:false` → every folder opens
  trusted, no dialog). The feature gates running tasks/builds from
  checkouts you don't control — but this session-gated editor already IS
  the same uid-2000 shell the terminal tab grants, so gating it on itself
  buys nothing. (The dialog's choice also persists browser-side —
  APPLICATION_SHARED storage lives in the browser, not the home volume —
  so without the flag it would nag once per folder per browser forever.)
- **telemetry is off twice over**: VSCodium is the telemetry-free build
  (the pinned tarball's `product.json` carries no `enableTelemetry` key —
  verified at the current pin), and the entrypoint pins
  `--telemetry-level off` regardless.

The image also carries what the workbench needs to know the stack:

- **git** (apt) — the built-in Git/SCM extension and the integrated
  terminal shell out to it (VSCodium flags it missing otherwise).
- **Bundled extensions** — one global set covering the repo's stack,
  pinned Open VSX `.vsix`s sha256-verified at build into
  `/opt/editor-bundled-extensions` (the same supply-chain discipline as
  the tarball): the official **Astro** extension (platform `.vsix`, one
  sha256 per arch — its language server ships per-OS bits), **ESLint**
  (`eslint.config.mjs` — the repo's ESLint 9 flat-config lint gate) and
  **Prettier** (`.prettierrc`; the extension resolves the workspace's own
  `prettier` install — both universal `.vsix`, one sha256), **Playwright**
  (the repo's e2e toolchain), and **Red Hat's YAML** (compose/deploy
  configs — VS Code bundles no YAML of its own). The TypeScript, zod,
  Preact, and Lit halves of the stack need no extension: TS ships built
  into the workbench, the rest are plain libraries with no marketplace
  integration worth bundling. The entrypoint installs the set offline
  into the home volume on first boot — a marker keyed on the `.vsix`
  hashes makes later boots a no-op and re-runs exactly when the image's
  pins move — and a failure degrades to an editor without the bundle,
  never a dead container. What the user installs or removes from Open VSX
  afterwards is theirs: the marker only ever (re)adds the bundled set.

Server data (user-data, extensions, logs) lives under `$HOME`
(`.vscodium-server`, `.local/state/VSCodium`) on the persistent
`cybermole-editor-home` volume; `editor-init` chowns it on first up —
empty named volumes start root-owned and uid 2000 must write `$HOME`. The
workspace volume mounts at the same `/workspace` path the tmux split uses
(path agreement).

Open VSX is the default gallery: the pinned tarball's `product.json`
(verified at the current pin — `extensionsGallery.serviceUrl` is
`https://open-vsx.org/vscode/gallery`) points there, so `VSCodium build`
needs no gallery flag. Gallery queries are the editor container's own
server-side egress. Operators can repoint or empty it with
`VSCODE_GALLERY_*` env vars if they want the marketplace fully off.

## compose (part of the plain stack)

The editor container ships in the plain `docker compose up -d` / `npm
start` stack, and cybermole's `CYBERMOLE_EDITOR_UPSTREAM` defaults to
`http://editor:3000` — the editor tab works out of the box. Opt out by
setting the variable EMPTY in `.env` next to compose.yaml (the `-`
interpolation form honors an explicit empty): editor off everywhere,
cybermole boots clean, `/editor/*` answers 404, the console hides its
affordances — the idle editor container is cheap to leave running.
Nothing publishes a port: the compose network is the only door.

## Plain host (the single-user shape)

`deploy/install-host.sh` installs the editor by default (`--without-editor`
skips it): the same pinned reh-web tarball and bundled extensions as the
image, sha256-verified, unpacked to `$STATE_DIR/editor`, with the
extensions installed into `~/.vscodium-server`. The installer carries its
own copy of the Dockerfile's pins (it can run outside the checkout);
`tests/unit/editor.test.mjs` fails if they drift. A re-run with new pins
replaces the install.

With `CYBERMOLE_EDITOR_UPSTREAM` **unset**, a server that finds
`$STATE_DIR/editor/out/server-main.js` spawns and supervises it (the app
host's restart loop: doubling backoff, never gives up, stopped on
shutdown). It runs as the server's own uid, so it edits the user's real
files. The bundled `node` is spawned directly, because `bin/codium-server`
is a sh wrapper that doesn't exec and a SIGTERM to it would orphan the
server. It listens on a **unix socket**, `$STATE_DIR/editor-run/editor.sock`
in a 0700 dir, never a port: it runs without a connection token, so on a
shared box a loopback port would be a shell for every local user. The
supervisor unlinks a stale socket before each spawn (listen() won't reuse
it), and the path must stay under the ~107-byte unix socket limit.
`CYBERMOLE_EDITOR_UPSTREAM` set empty turns it off; set to a URL, it
proxies there instead. A state dir with no install (e2e's hermetic one)
means editor off.

## The proxy (server/main.ts + src/lib/terminals/editor.ts)

`CYBERMOLE_EDITOR_UPSTREAM` (e.g. `http://editor:3000`; origin only, validated
at boot by `readEditorUpstream`) is the single switch. Everything under
`${BASE}/editor` — HTTP and WS — proxies to it, behind the origin check
and the session gate, after the auth branch and before Astro. The policy
surface lives in `src/lib/terminals/editor.ts`
(path routing, header set, body cap, tunnel tracking) so units cover it
without booting the server; the transport lives in `server/main.ts`:

- **HTTP**: streamed both ways (`pipe`, never buffered — the workbench
  bundle is ~20 MB). Hop-by-hop headers stripped; **the original `Host`
  header is forwarded unchanged** — the editor embeds it as
  `remoteAuthority`, which is how the browser learns to dial its WS back
  through the proxy. Upstream failures answer 502; an idle upstream is
  cut at 120 s.
- **Editor HTML carries its own header set** via the hardenResponse
  override (handler-set headers win): `X-Frame-Options: SAMEORIGIN`
  (overriding the global DENY) + a CSP pinned against the vendored
  workbench
  (`worker-src 'self' blob:`, `img-src 'self' data: blob:`,
  `frame-src 'self'`, `connect-src 'self' ws: wss:` — marketplaces
  deliberately absent; `editorSecurityHeaders()` is the single place to
  flip that). Assets keep the global security headers.
- **Editor HTML is also the one buffered, REWRITTEN body**: the boot
  document's `vscode-workbench-web-configuration` meta gets
  `configurationDefaults` injected (`window.autoDetectColorScheme` + the
  preferred dark/light themes — `injectWorkbenchThemeDefaults` in
  src/lib/terminals/editor.ts), so the workbench opens in the BROWSER's color
  scheme. It parses only folder/workspace/ew URL params (no `?theme=`), and
  window-scope theme settings live browser-side, so neither a URL param nor
  home-volume settings.json can do it — the construction options are the
  one channel that works. The console reloads the iframe pane on a scheme
  flip (`armEditorThemeReload` in src/components/editor-pane.ts). Capped at
  `EDITOR_HTML_REWRITE_MAX_BYTES`; a shape change upstream degrades to
  passing the bytes through untouched.
- **Bodies**: editor routes keep a large cap (`EDITOR_MAX_BODY_BYTES` =
  the upload cap — sized to a large editor save, not the JSON API's
  10 KiB), ACCEPT length-less/chunked bodies (never 411), and swap the
  5-minute whole-body deadline for the upload route's stall guard.
- **WebSocket**: a prefix branch in the `upgrade` handler BEFORE the `/ws`
  equality check — the browser dials
  `${BASE}/editor/stable-<commit>?reconnectionToken=…` (two per window:
  Management + ExtensionHost). Gates: `shuttingDown`, Origin (present +
  matching — the iframe always sends one), the session gate. **NOT** the
  terminal `wsLimiter` (several sockets per window would throttle two
  tabs). The socket is a **raw byte tunnel** to the upstream — never the
  terminal `wss`/`attach` path, no pty, no frame parsing, no payload cap —
  and it is **tracked per token** (`EditorTunnelTracker`): `POST /logout`,
  "log out everywhere" and shutdown cut editor shells with the terminals
  (the 30-second guarantee), and each tunnel runs a 30 s expiry sweep
  (`auth.alive`, non-renewing — WS traffic never slides a token).
- **Access log**: `/editor/*` is in `quietAccessPath` (an IDE's worth of
  asset traffic at http level would bury the console).

Unauthenticated `/editor/*` answers **401** (a data route, never the login
page); unconfigured answers **404**.

## Service worker, dev proxy, state

- `public/sw.js`'s fetch handler skips `editor/` exactly like `api/` and
  `partials/`: VS Code's asset paths are unhashed, so stale-while-
  revalidate would serve mixed-version workbench assets after an upgrade,
  authed editor content would stay cached beyond logout, and the offline
  shell would render inside the iframe. (The cache `VERSION` is bumped on
  change so old caches drop on activate.)
- `astro.config.mjs`'s dev proxy forwards `<base>editor` (ws: true) to the
  dev services server, which owns the proxy.
- The console state (`/api/state`'s `console_state`) carries
  `editor: boolean` — `CYBERMOLE_EDITOR_UPSTREAM` set? — which gates the
  editor affordances. The editor opens per workspace: the console's
  editor tab and `/view?w=<workspace uuid>`'s single page both build the
  workbench iframe the same way (`editorSrc` in
  `src/components/editor-pane.ts` —
  `${BASE}/editor/?folder=<cwd>`), so a folder opens by URL, no POST, no
  server call.

## Security notes

- The editor never publishes a port: in compose the network is the
  boundary, and on a plain host it's a unix socket in a 0700 dir.
- CSP `connect-src` refuses marketplaces in the BROWSER; the editor
  container's own egress is the operator's (like any container). To take
  Open VSX fully offline, unset the gallery via `VSCODE_GALLERY_*`.
- VSCodium is the telemetry-free build (no `enableTelemetry` wiring in the
  pinned `product.json`); the entrypoint pins `--telemetry-level off` on
  top.
- The image pins the release (sha256 at build). Upgrades are an image
  rebuild; the SW bypass guarantees a half-upgraded browser can't mix
  versions.

## Post-deploy verification

Two manual checks this sandbox can't run for you (no docker) — worth a
few minutes after the first deploy and after any editor pin move:

1. **Marketplace stays server-side (no CSP violation).** Open the console,
   sign in, open a workspace's editor tab, and click the workbench's
   Extensions viewlet (a marketplace query — the one editor flow that
   touches a non-self origin). Open the browser devtools **inside the
   editor iframe** (right-click the workbench → *Inspect*, or select the
   `editor-frame` iframe context in the console dropdown) and watch the
   console while the viewlet loads its results. Expected: results load,
   no CSP violation. If a `Content-Security-Policy` violation naming
   `open-vsx.org` appears, the workbench started dialing the gallery from
   the browser — add it to `connect-src` in `editorSecurityHeaders()`
   (`src/lib/terminals/editor.ts`, the single place the editor CSP
   lives), and re-check; marketplace queries are *supposed* to go through
   the editor container (`product.json`'s gallery wiring above).
2. **Nested base path.** Deploy with `CYBERMOLE_BASE=/foo` set for the
   whole stack (the entrypoint interpolates it into
   `--server-base-path ${CYBERMOLE_BASE%/}/editor`). Sign in at
   `/foo/`, open the editor tab: the workbench must serve under
   `/foo/editor/` — assets load (no blank workbench / "Missing workbench
   asset" error), and the WS connects (the status bar shows a live
   extension host, no *Reconnecting…* toast). If assets 404, the base
   interpolation between compose (`CYBERMOLE_BASE` env) and the
   entrypoint drifted — check both before anything else.
