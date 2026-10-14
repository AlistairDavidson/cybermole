# The editor webapp — VSCodium reh-web, same-origin (task/ws-editor)

Replaces the Zed/KasmVNC webapp (docs/zed-webapp.md, deleted): streaming a
desktop GUI was the poor fit — separate basic auth, one instance, no
per-folder URLs, a launcher container. The editor is now **VSCodium's
reh-web build** ("`codium serve-web`" — self-hosted VS Code in the browser
with server-side files), served through web-pi's **same-origin
`/editor` proxy** behind the session gate. The spike that pinned this
design (against a real browser, through a real proxy) is
**docs/editor-spike.md** — read it first; this document describes what
shipped.

## Architecture

```
                browser (one origin, the console's)
      ┌──────────┴────────────────┐
      │ https://webpi…/           │  /  (console)      /editor/?folder=…  (iframe)
      └──────────┬────────────────┘
        nginx TLS│ (one vhost — deploy/nginx-webpi.conf; ws upgrades already mapped)
      ┌──────────┴───────────────────────────┐
      │ webpi (uid node)                     │ server/main.ts
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

Trust level, stated like the Zed doc did: the editor's integrated terminal
is another web shell as **the same uid 2000** the terminal already gives
you. It sits behind the session gate like every other route — logout /
"log out everywhere" cut its sockets with the terminals (below). It never
touches the tmux socket or web state.

## The image (`editor/`)

A thin in-repo image (the `zed/` precedent): Debian bookworm-slim + the
**pinned** `vscodium-reh-web-linux-{x64,arm64}-<version>.tar.gz`
(sha256-verified at build, both hashes as `ARG`s) extracted intact to
`/opt/editor`. uid 2000 / gid 2001 (`workspace`/`webpi`, the split's
users), umask 0007. The entrypoint runs the tarball's own
`bin/codium-server`:

```
--host 0.0.0.0 --port 3000 \
--server-base-path "${WEB_PI_BASE%/}/editor" \
--without-connection-token \
--telemetry-level off
```

- auth is upstream — web-pi's session gate; there is no connection token,
  no launcher, no token file.
- the base path interpolates from `WEB_PI_BASE` exactly like the webpi
  service's, so asset URLs line up with the proxy.
- the first folder open shows VS Code's **workspace-trust dialog** once
  (persists in user data — the home volume).

Server data (user-data, extensions, logs) lives under `$HOME`
(`.vscodium-server`, `.local/state/VSCodium`) on the persistent
`webpi-editor-home` volume; `editor-init` (the `zed-init` precedent) chowns
it on first up — empty named volumes start root-owned and uid 2000 must
write `$HOME`. The workspace volume mounts at the same `/workspace` path
the tmux split uses (path agreement).

Open VSX is the default gallery (VSCodium build); its queries are the
editor container's own server-side egress. Operators can repoint or empty
it with `VSCODE_GALLERY_*` env vars if they want the marketplace fully off.

## compose (`--profile editor`)

```sh
WEB_PI_EDITOR_UPSTREAM=http://editor:3000 docker compose --profile editor up -d
```

Set the var in `.env` next to compose.yaml so `up -d` recreates webpi with
the proxy on; `up -d editor` alone boots the editor next to a running webpi
whose env still has it off. Unset/empty = editor off everywhere: web-pi
boots clean, `/editor/*` answers 404, the console hides its affordances.
Nothing publishes a port: the compose network is the only door.

## The proxy (server/main.ts + src/lib/editor.ts)

`WEB_PI_EDITOR_UPSTREAM` (e.g. `http://editor:3000`; origin only, validated
at boot by `readEditorUpstream`) is the single switch, replacing the Zed
triple. Everything under `${BASE}/editor` — HTTP and WS — proxies to it,
behind the origin check and the session gate, after the auth branch and
before Astro. The policy surface lives in `src/lib/editor.ts`
(path routing, header set, body cap, tunnel tracking) so units cover it
without booting the server; the transport lives in `server/main.ts`:

- **HTTP**: streamed both ways (`pipe`, never buffered — the workbench
  bundle is ~20 MB). Hop-by-hop headers stripped; **the original `Host`
  header is forwarded unchanged** — the editor embeds it as
  `remoteAuthority`, which is how the browser learns to dial its WS back
  through the proxy (spike finding 4). Upstream failures answer 502; an
  idle upstream is cut at 120 s.
- **Editor HTML carries its own header set** via the hardenResponse
  override (handler-set headers win): `X-Frame-Options: SAMEORIGIN`
  (overriding the global DENY) + a CSP pinned by the spike
  (`worker-src 'self' blob:`, `img-src 'self' data: blob:`,
  `frame-src 'self'`, `connect-src 'self' ws: wss:` — marketplaces
  deliberately absent; `editorSecurityHeaders()` is the single place to
  flip that). Assets keep the global security headers.
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
  shell would render inside the iframe. (Version bumped to `web-pi-v3` so
  old caches drop on activate.)
- `astro.config.mjs`'s dev proxy forwards `<base>editor` (ws: true) to the
  dev services server, which owns the proxy.
- `GET /api/state` (old shape, until task/ws-console) carries
  `editor: boolean` — `WEB_PI_EDITOR_UPSTREAM` set? The sidebar's ⌷ buttons
  and `<console-app>`'s `open-editor` handler use it; a click is
  `window.open(`${BASE}/editor/?folder=${encodeURIComponent(cwd)}`)` —
  a folder opens by URL, no POST, no server call.

## Security notes

- The editor never publishes a port; the compose network is the boundary.
- CSP `connect-src` refuses marketplaces in the BROWSER; the editor
  container's own egress is the operator's (like any container). To take
  Open VSX fully offline, unset the gallery via `VSCODE_GALLERY_*`.
- VSCodium is the telemetry-free build; the entrypoint pins
  `--telemetry-level off` on top.
- The image pins the release (sha256 at build). Upgrades are an image
  rebuild; the SW bypass guarantees a half-upgraded browser can't mix
  versions.

## Host-side verification

docs/editor-spike.md has the checklist (framing, trust dialog, terminal as
uid 2000, logout cutting shells, nested-base deployments, and the one
Extensions-viewlet CSP check). The sandbox verified everything at the
proxy+browser level; the container wiring (compose, init chown, umask) is
host verification.
