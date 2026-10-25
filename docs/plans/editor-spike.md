# Editor spike — VSCodium reh-web behind cybermole's same-origin proxy (task/ws-editor)

Plan §8 made this spike the branch's first task: same-origin-under-base-path
is the CANDIDATE (microsoft/vscode#208278 — WebSocket subpath breakage under
a base-path reverse proxy — is the known risk), cross-origin subdomain +
`--connection-token` the fallback. This document records what ran, what was
observed, and what each shipped decision rests on.

## Verdict

**Primary design confirmed: same-origin, under `CYBERMOLE_BASE`, no connection
token.** The workbench loads in an iframe through a same-origin reverse
proxy, its WebSockets dial back through that same proxy under the base
path, folders open by URL param, and the integrated terminal round-trips.
The fallback was not needed.

## What ran (environment honesty)

The sandbox has no docker daemon, so nothing here ran in a container. It
does have network and a headless-capable Chromium:

- **Chromium 147 (playwright `chromium-1217`)** — installed via
  `npx playwright install chromium`; the sandbox lacks the ~20 GUI shared
  libraries and has no root, so the Debian bookworm `.deb`s for exactly the
  missing libs (libglib2.0-0, libnss3, libx11-6, libgbm1, …) were extracted
  to `/tmp/libs/root` and the browser launched with `LD_LIBRARY_PATH`
  pointing there. Full `chrome` and `chrome-headless-shell` both ran.
- **The pinned reh-web tarball itself** — downloaded, sha256-verified
  against the release sidecar, extracted, and `bin/codium-server` run
  directly on 127.0.0.1.
- **A spike proxy** (`/tmp/editor-spike/spike-proxy.cjs`, ~70 lines) that
  mirrors the shipped design: forwards `/editor/*` (HTTP, streamed) with
  the original `Host` header, raw-pipes `/editor/*` WebSocket upgrades, and
  swaps the header set on HTML responses. It is the design that became
  `server/main.ts`'s proxy; the shipped code is not byte-identical to the
  spike script.
- One caveat the orchestrator should know: in this constrained sandbox the
  browser **OOM'd when the Extensions viewlet was opened** (the crash
  reproduces on the second heavy interaction of a session), so the
  marketplace-gallery question below is pinned from product/source
  evidence, not a completed browser interaction. Everything else was
  verified against the real browser.

## The pin (release asset)

VSCodium stable release **`1.140.06880`** (published 2026-10-13, the
current stable at spike time), asset
`vscodium-reh-web-linux-x64-1.140.06880.tar.gz` (101,128,597 bytes):

```
sha256 f16388ea58170613c6d5e492aa10410a471e1d86d8cb343e3c8147493a7981a9
```

arm64: `vscodium-reh-web-linux-arm64-1.140.06880.tar.gz`
`sha256 d21cccd1f21f0960b0b4ecb366149a6883bd1c5c5ecd0b32d44e65a618096a9f`.

Tarball layout (verified by extraction): `bin/codium-server` (a `sh` wrapper
resolving its own root, execing the bundled `./node out/server-main.js`),
`node`, `out/`, `extensions/`, `product.json` (`serverApplicationName:
"codium-server"`, `quality: "stable"`). Both pins live as `ARG`s in
`editor/Dockerfile` with the sha256 checked at build.

## Verified live (real browser, through the proxy)

Each item below was observed, not inferred:

1. **The server and its flags.** `bin/codium-server --host 127.0.0.1
   --port 3999 --server-base-path /editor --without-connection-token
   --telemetry-level off` boots and serves. **No
   `--accept-server-license-terms` is needed** (verified: boots and binds
   without it — VSCodium is MIT; the flag exists for MS builds). Data lands
   under `$HOME/.vscodium-server/{data,extensions}`, logs under
   `$HOME/.local/state/VSCodium` — HOME is the persistent home volume.
   `--version` prints `1.140.06880` / commit / arch (used as the Dockerfile
   build sanity check).
2. **Framing.** The workbench loads inside a same-origin `<iframe>` when the
   HTML carries `Content-Security-Policy: … frame-ancestors 'self'` and no
   `X-Frame-Options: DENY` (the spike proxy stripped XFO and set that CSP).
   Titlebar/sidebar/editor parts render; the Explorer shows the folder's
   files (`["subdir","hello.txt"]` in `.monaco-list-row`s).
3. **WebSocket behavior — the #208278 question.** The browser dials
   `/editor/stable-<commit>?reconnectionToken=…&reconnection=false&skipWebSocketFrames=false`
   — same-origin, under the server base path, built from the page's own
   location. **Two WebSockets per window** (Management + ExtensionHost),
   both established through the proxy and both carrying the session. No
   absolute-path or cross-origin WS was ever attempted. The same holds
   under a nested base (`--server-base-path /foo/editor`, proxied at
   `/foo/editor/*`: workbench rendered, `serverBasePath:"/foo/editor"`
   embedded).
4. **Host header forwarding matters.** The workbench HTML embeds
   `"remoteAuthority":"<request Host>"` — the proxy must forward the
   ORIGINAL Host header (not the upstream's), which is how the browser
   learns to dial its WebSocket back through the proxy. The shipped proxy
   does exactly this.
5. **`?folder=` param shape.** Both `?folder=/tmp/editor-spike/proj` (plain)
   and `?folder=%2Ftmp%2Feditor-spike%2Fproj` (URI-encoded) open the folder
   in the Explorer (the workbench normalizes both). **PIN:
   URI-encoded** (`encodeURIComponent(cwd)`) — the safe shape for paths
   with spaces, `?`, `#`, `&` — used by the console's `window.open`.
6. **Integrated terminal.** Focused the workbench, `Ctrl+\`` opened the
   terminal pane (`.terminal` present), typed
   `touch /tmp/editor-spike/proj/terminal-marker.txt` → the file appeared
   on disk. Input round-trips through the proxied WS; the pty runs as the
   server's own uid (2000 in the image).
7. **First-open workspace-trust dialog.** "Do you trust the authors of the
   files in this folder?" with a "Trust Folder & Continue" button appears
   on first open of a folder; the choice persists in user data (the
   persistent `cybermole-editor-home` volume answers it once per folder).
   Worth knowing for host-side verification — it is not an error.
   **[Superseded at merge: the shipped entrypoint passes
   `--disable-workspace-trust` — the served workbench embeds
   `enableWorkspaceTrust:false` and folders open trusted with no dialog.
   The choice also turned out to persist browser-side (APPLICATION_SHARED
   storage lives in the browser, not the home volume), so without the flag
   it would have nagged once per folder per browser forever.]**
8. **CSP held / blocked as designed.** With the shipped header set
   (`worker-src 'self' blob:`, `img-src 'self' data: blob:`, `frame-src
   'self'`, `connect-src 'self' ws: wss:`, inline script/style allowed):
   the workbench fully booted, blob: workers loaded (the "web worker
   extension host is started in a same-origin iframe" warning is upstream's
   normal same-origin mode, not a failure), and the ONLY console CSP
   violations were two browser-side advisory fetches the design
   deliberately refuses:
   - `https://raw.githubusercontent.com/EclipseFdn/publish-extensions/.../extensions.json`
     (extension-control blocklist, advisory — the workbench continued)
   - `https://raw.githubusercontent.com/VSCodium/vscodium/master/announcements-extra.json`
     (cosmetic)

   Both were refused and nothing user-visible broke.

## Pinned from product/source (not completable in this sandbox)

- **The extension marketplace (Open VSX) routing.** Across four full
  workbench sessions with network capture, the browser NEVER attempted a
  fetch to `open-vsx.org` — gallery queries ride the remote connection (the
  editor container's own server-side egress; `out/server-main.js` reads
  `VSCODE_GALLERY_*` env overrides server-side, which corroborates the
  server-side gallery service). The one hole: opening the Extensions
  viewlet crashed this sandbox's browser before a query could be observed.
  **PIN: `connect-src` stays closed to open-vsx.org.** If host verification
  shows the viewlet attempting browser-side gallery fetches (CSP violation
  naming open-vsx.org in the iframe console), add it to `connect-src` in
  ONE place: `editorSecurityHeaders()` in `src/lib/editor.ts`.
- **The WS handshake bytes.** The shipped proxy copies the upstream's 101
  response headers verbatim rather than re-deriving them — nothing to pin.

## Decisions → code map

| Decision | Where it lives |
|---|---|
| Same-origin under `CYBERMOLE_BASE`, no token | `compose.yaml` (editor profile), `editor/docker-editor-entrypoint.sh` |
| Pin + sha256 | `editor/Dockerfile` `ARG`s (both arches) |
| Original-Host forwarding | `proxyEditorRequest` / `upgradeEditorSocket` (server/main.ts) |
| `?folder=` URI-encoded | `console-app.ts` open-editor listener |
| Editor header set | `editorSecurityHeaders()` (src/lib/editor.ts) + applied to HTML in `proxyEditorRequest` |
| Marketplaces denied in browser CSP | `editorSecurityHeaders()` — the single constant to flip |
| WS handshake headers (`Connection: Upgrade` re-added after the hop-by-hop strip — without them no upstream answers 101) | `editorUpgradeHeaders()` (src/lib/editor.ts) |
| SW bypass | `public/sw.js` fetch handler (`editor/` beside `api/`, `partials/`) |

### Review finding (round 1) — the WS handshake headers

The first shipped transport forwarded the browser's upgrade headers minus
the hop-by-hop list — which strips `Connection`/`Upgrade` — so the upstream
saw a plain GET and never answered 101 (the spike proxy worked because it
forwarded headers verbatim; the shipped code diverged from it). Found in
review, reproduced both ways against a live upgrade server (fixed shape →
101 + byte round-trip; stripped shape → plain 200, no tunnel), and fixed
by extracting `editorUpgradeHeaders()` into the policy module with a unit
regression guard — nginx's `proxy_set_header Upgrade/Connection` is the
same dance.

## Host-side verification (run these at merge time)

1. `docker compose --profile editor up -d` with
   `CYBERMOLE_EDITOR_UPSTREAM=http://editor:3000` — `/editor/` serves the
   workbench through the console's origin; sign in, open a workspace
   folder from the sidebar's ⌷ button, expect files (no trust dialog —
   `--disable-workspace-trust`; git present — SCM view live; the bundled
   Astro/Playwright/YAML extensions listed under Installed).
2. Open the **Extensions viewlet** and browse; watch the iframe console for
   a CSP violation naming `open-vsx.org` (see the pin above — flip the one
   constant if it appears).
3. The integrated terminal as uid 2000: `touch /workspace/marker` in the
   editor terminal appears owned by 2000 in a cybermole terminal.
4. Log out of the console with an editor tab open: its shells (terminal,
   extension host) must die within seconds (the per-token tunnel cut).
5. `CYBERMOLE_BASE=/foo` deployment: the workbench under `/foo/editor/`
   (spike-verified at the proxy level; worth one host pass).
