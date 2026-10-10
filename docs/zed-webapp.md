# Zed as a webapp (task/zed-webapp)

Research + prototype for one slice of the TODO's console features — the
side-tab bar where a session can be opened in pi / **zed** / terminal /
app preview. This document covers only the Zed piece: can it work, what
it takes to run it, how the stream reaches the browser, how the console
opens a specific session cwd in it, and what a human must verify on the
host (the agent sandbox has no docker daemon — everything container-side
below is statically validated only).

## Verdict in one paragraph

**Yes, Zed runs in a headless Linux container** — with Mesa's CPU Vulkan
driver (lavapipe/llvmpipe) behind a virtual X server, all of Zed's Linux
dependencies are satisfiable in Docker without a GPU, dbus or a real
desktop. It is not officially supported ("While it's not _impossible_ to
run Zed inside Docker, it's not an officially supported method" —
[mrnugget/yeskunall on #49131](https://github.com/zed-industries/zed/issues/49131)),
and software rendering is the weak point: reports range from "works with
a performance warning" to "unbelievably laggy" depending on CPU and how
the pixels travel. We pair it with **KasmVNC** (web-native VNC with its
own browser client, dynamic resolution, clipboard sync, basic auth) on
its own loopback port behind the same TLS reverse proxy shape as the
console. There is **no official browser Zed** and the official remote
development path requires a local Zed UI over SSH, so streaming the real
GUI is the only faithful option today; an independent web port exists
and is worth watching (below).

---

## 1. Can Zed run headless in a container?

**Rendering: Vulkan is mandatory, and software Vulkan works.**
Zed's GPUI renders through Vulkan (docs: "[Zed requires a GPU to run
effectively. Under the hood, we use Vulkan](https://zed.dev/docs/linux)").
Since Zed 0.225 the Linux renderer is [wgpu, replacing
blade](https://github.com/zed-industries/zed/pull/46758) — and its
adapter selection accepts a CPU adapter for normal window creation: in
[`crates/gpui_wgpu/src/wgpu_context.rs`](https://github.com/zed-industries/zed/blob/main/crates/gpui_wgpu/src/wgpu_context.rs)
the `reject_software` flag is only set on the *device-recovery* retry
(`WgpuContext::new_rejecting_software`), while ordinary creation sorts
adapters "Discrete > Integrated > Other > Virtual > Cpu" and takes what
configures the surface. So `libvulkan1` + `mesa-vulkan-drivers`
(lavapipe) is the GPU story in a container. Evidence it actually works:

- [#49131 "panic while running inside
  Docker"](https://github.com/zed-industries/zed/issues/49131): missing
  `libvulkan.so.1` panics with a misleading zbus error; after
  `apt install libvulkan1 mesa-vulkan-drivers`, Zed 0.223.3 in the
  container logs `Using GPU: GpuSpecs { is_software_emulated: true,
  device_name: "llvmpipe (LLVM 15.0.7, 256 bits)" }`, renders its first
  frame and stays up. (The follow-up "unbelievably laggy" report was
  X11-forwarding the window to the host over TCP — a much worse pixel
  path than the one we use; see below.)
- The [webxr-compositor
  project](https://tangled.org/overby.me/overby.me/commit/3b76d998c3f7adaaf9c2e7819f04a82631f55fa9)
  drives an entire browser-side compositor this way: "Zed runs on the
  compositor through Mesa software Vulkan: lavapipe presents via wl_shm
  … the full editor UI renders and accepts mouse and keyboard input",
  including typing assertions against rendered pixels.

**Display server: X11 is the pragmatic choice.** Zed picks X11 or
Wayland at runtime (`WAYLAND_DISPLAY=''` forces X11 — [Zed Linux
development docs](https://github.com/zed-industries/zed/blob/main/docs/src/development/linux.md)).
#49131 shows the X11 path working in-container; #18350 shows the
Wayland path *crash* with `NoCompositor` when nothing provides
`wayland-0` (a headless Zed dev-server in Apptainer — closed as
"architecture changed"). KasmVNC **is** an X server (an Xvnc), so the
container needs no weston/Xvfb of its own: Zed talks X11 to KasmVNC
directly, and KasmVNC streams its framebuffer. A compositor-less X
session is fine (Zed logs "no compositor present, falling back to
server-side window decorations" and carries on — #49131 logs); we run
openbox anyway so multi-window Zed, focus and RandR resizes behave.

**Everything else:**
- **dbus — not required.** #49131's full log shows Zed continuing past
  `ERROR [crates/client/src/client.rs:364] DBus error … No such file or
  directory` to a rendered first frame. (The panic that opens that issue
  is the *notification attempt* failing while reporting the missing-Vulkan
  error — a fixed diagnostic path, not a dbus requirement.) We ship no
  dbus daemon. Known cost: XDG portals are absent, so Zed's native
  file-picker and its system-keychain secret storage degrade (API keys
  entered in Zed may not persist across restarts — verify on the host,
  below).
- **fontconfig + a font** — cosmic-text needs system fonts
  (`fonts-dejavu-core` + `fontconfig` in the image).
- **glibc ≥ 2.31** for Zed's official builds ([Zed on
  Linux](https://zed.dev/docs/linux)); Debian bookworm (2.36) for both
  Zed and the KasmVNC 1.5.0 deb (which needs ≥ 2.35).
- **`XDG_RUNTIME_DIR`** should exist and be writable (repeated
  "XDG_RUNTIME_DIR not set" noise in #49131; the entrypoint creates
  `/tmp/xdg-runtime`, mode 700).
- **libasound2** (audio dlopen) and **libxkbcommon(-x11)** round out the
  runtime libs; **rsync** is only wanted by Zed's self-updater, which we
  disable (`auto_update: false` in the seeded settings — the image pins
  the release).

**Performance expectation — set honestly:** every software-rendering
report is "usable, not native". [#14402
(VMware)](https://github.com/zed-industries/zed/issues/14402) and
[#37649 (VirtualBox)](https://github.com/zed-industries/zed/discussions/37649)
describe slideshow framerates; [#57002](https://github.com/zed-industries/zed/issues/57002)
tracks the general "software-emulated GPUs" problem; Zed itself only
gates emulated GPUs on Windows (`ZED_ALLOW_EMULATED_GPU=1` override —
[#42632](https://github.com/zed-industries/zed/issues/42632)). Two
things make this acceptable for us: an editor UI is mostly static (only
the caret/scroll damage re-encodes), and the pixel path is
lavapipe → KasmVNC's damage-tracked JPEG/WebP regions over websockets —
not X11-over-TCP like the worst report above. The host-side checklist
includes a subjective typing-latency check; if it disappoints, the
fallbacks are a GPU-passthrough host device (KasmVNC `desktop.gpu.hw3d`)
or the web port below.

## 2. Streaming: KasmVNC (chosen) vs noVNC+x11vnc vs Sunshine/WebRTC

We stream the *screen*, not the app — Zed has no remote-UI protocol to
forward (unlike VS Code's server), so the options are the classic
desktop-streaming trio:

| | KasmVNC ([kasmtech/KasmVNC](https://github.com/kasmtech/KasmVNC)) | noVNC + x11vnc + Xvfb | Sunshine/Moonlight ([LizardByte/Sunshine](https://github.com/LizardByte/Sunshine)) |
|---|---|---|---|
| Browser client | built into the server (one process) | 3 moving parts (websockify, noVNC app, x11vnc) | none official — third-party web clients (moonlight-web projects) |
| Clipboard sync | bidirectional, built in (DLP config controls it) | not without extra glue | client-dependent |
| Dynamic resize | yes — client viewport drives RandR (`desktop.allow_resize`) | no — Xvfb geometry fixed at boot | fixed stream resolution |
| Encoding | damage-tracked JPEG/WebP regions; optional WebRTC-UDP + video mode | VNC rect encodings (dated) | H.264/HEVC/AV1 hardware or software — best-in-class latency |
| Auth | basic auth (`kasmvncpasswd`), brute-force blacklist | none native (nginx layer) | PIN pairing, per-client |
| Maintenance | active (1.5.0, Oct-era releases), YAML config, man pages | [x11vnc unmaintained, seeking a maintainer](https://vnc.com/vnc-server-linux/) | active, but games-first; heavier ops (certs, pairing, app configs) |

**Pick: KasmVNC.** Rationale: for a single-user self-hosted *editor* the
priorities are clipboard, resize-to-browser-window, one-process
simplicity and boring config — KasmVNC wins the first three outright and
ties on the fourth; its latency (websocket JPEG/WebP) is fine for
editor-paced interaction, while Sunshine's WebRTC advantage pays off for
full-screen video/gaming we don't have, at the cost of the most complex
ops and no first-party browser client. noVNC+x11vnc loses on
maintenance (x11vnc is explicitly unmaintained) and lacks resize +
clipboard. We install the **KasmVNC deb on debian:bookworm-slim**
(`kasmvncserver_bookworm_1.5.0_amd64.deb`) rather than building `FROM
kasmweb/*`: the kasmweb app images hardwire their own uid-1000
`kasm_user` + root startup machinery, while we need uid 2000 (the
workspace user), our own entrypoint, and pinned, reviewable layers. The
deb is the same server the kasmweb images wrap.

Pins: **KasmVNC v1.5.0**, **Zed v1.23.2** (stable, 2026-10-07; both
recorded as `ARG`s in `zed/Dockerfile`).

## 3. Is there an official Zed-in-a-browser path? (No.)

- **Remote development is SSH + local UI.** Zed's [remote
  development](https://zed.dev/docs/remote-development) runs a headless
  `zed-remote-server` on the remote host, but the *UI stays local* —
  "Remote Development lets you edit code on a remote server **while
  running Zed locally**". The browser never participates; the protocol
  is spoken over SSH ControlMaster connections by a local Zed build. So
  it cannot serve the console's "open Zed in a tab" — ruled out. (Its
  dev-containers feature is the same shape: docker/podman invoked by the
  *local* Zed.)
- **No web build.** Zed's client is GPUI; there is no wasm/browser
  target in the official repo. GPUI does compile to wasm (the framework
  advertises web support), which is what makes the unofficial port
  possible:
- **Independent port worth watching: [`zee295/zed-web`](https://hub.docker.com/r/zee295/zed-web)**
  — a fork where "the browser provides the editor UI and WebGPU
  renderer; filesystem access, SQLite, Git, terminals, language servers,
  debuggers, extensions, and ACP agents run in the container". That is a
  *native* web Zed (no pixel streaming) and architecturally the better
  end-state, but it is explicitly "an independent web port, not an
  official Zed web release … preview status", tracks upstream on its own
  cadence, and its auth/proxy posture (COEP/COOP headers, own token)
  doesn't fold into web-pi's model yet. **Ruled out for v1; revisit when
  it matures** — our console hook is URL-shaped precisely so the
  implementation behind it can change.

## 4. Opening a specific folder in the *running* Zed

The console's web container has no docker socket by design — it cannot
`docker exec`. What can reach the zed container is the compose network,
so the mechanism is a **tiny authed HTTP launcher inside the zed
container** (`zed/zed-launcher.py`):

```
browser ── click "open in Zed"
   │  window.open(WEB_PI_ZED_URL)            (tab opens immediately)
   └─ POST /api/zed/open {path}              (web-pi server, session cookie)
        └─ POST http://zed:7999/open          (compose network, Bearer token)
             Authorization: Bearer <token>    (zed-init generates, both sides load)
             └─ setsid zed /workspace/<cwd>   (uid 2000, DISPLAY=:1)
```

Why `zed <path>` is the whole trick on the receiving end
([`crates/cli/src/main.rs`](https://github.com/zed-industries/zed/blob/main/crates/cli/src/main.rs)):
the CLI builds a `zed://` open-request and tries to connect a datagram
socket at `<data_dir>/zed-<channel>.sock` (i.e.
`~/.local/share/zed/zed-stable.sock`):

- **connected** → it sends the open-request to the running instance
  (which opens/focuses the workspace window) and exits;
- **not connected** → it double-forks (setsid) and execs the editor with
  the path as the first workspace.

So one invocation means "make sure this folder is open in Zed", and Zed
needs **no supervisor**: the entrypoint only runs X + WM + launcher, Zed
boots lazily on the first open and re-boots itself after a crash on the
next one. (The window appears in the browser tab a moment after the
KasmVNC page connects — the toast reports the launch.)

Alternatives considered and dropped: a watched FIFO on the shared
/workspace volume (no feedback, no auth, polling lifecycle); tmux-driven
open via the workspace container (couples Zed to the tmux socket and
gives the terminal user a way to race the GUI); `xdotool`-style window
injection (fragile, needs Zed's keymap). The HTTP launcher gives health,
errors and an auth boundary in ~100 lines of stdlib.

Validation layers, both sides: the web server checks the path is
absolute + a directory it can `stat` (400 otherwise); the launcher
re-checks absolute + `realpath` under `/workspace` + `isdir` (400). The
token is generated once by the `zed-init` one-shot (the seaweedfs-init
pattern) onto a dedicated volume, read by webpi's `docker-entrypoint.sh`
and the zed entrypoint — file mode 0440, owner `workspace` (2000), group
`webpi` (2001) — the group both containers' users share.

**Trust level (stated explicitly):** the Zed GUI runs as **the same uid
2000 the terminal already gives you a shell as**. A browser session that
can click "open in Zed" could already type `rm -rf /workspace/*` into an
attached pi session — Zed adds no new capability, only a nicer editor
face on the same blast radius. The launcher's `/workspace` restriction
and bearer token are hygiene (it speaks on the compose network where the
workspace container also lives), not a security boundary. The one new
*surface* is the KasmVNC listener, which is why it has its own password
and never binds beyond the compose network + loopback publish.

## 5. Auth + networking for the stream

Options:

1. **Own loopback port + reverse-proxy vhost (chosen).** The zed
   container publishes `127.0.0.1:6901`; nginx fronts it with TLS
   (`deploy/nginx-zed.conf`, same shape as `nginx-webpi.conf` with the
   websocket upgrade map). Auth = KasmVNC's own basic auth
   (`ZED_VNC_PASSWORD` → `kasm_user` via `kasmvncpasswd`), a *separate*
   credential from the web-pi login.
2. Proxy the stream through the Node server behind the session cookie.
   Faithful SSO, but the Node server would have to tunnel a second
   websocket (and the client's own HTTP endpoints) through itself — real
   code, real buffering risk, and the cookie already means "a shell as
   uid 2000", so the SSO gain over option 1's extra password is small.
3. Sub-path on the web-pi origin (`/zed/`). Explicitly rejected:
   web-pi's own security model wants a dedicated hostname
   (README "Give web-pi its own hostname"), KasmVNC's client makes
   same-origin assumptions, and it would entangle two CSPs.

v1 is option 1: **simplest sound shape** — one proxy block, one
long-lived websocket, auth at the stream itself so the loopback port is
not a soft spot for local processes. Tradeoff noted: two logins (console
+ Zed stream), and the stream is not covered by the session-cookie
expiry. When the side-tab bar lands, option 2 can be revisited if the
tab should inherit the console session (the cookie-grants-a-shell
equivalence above is the argument that this is acceptable to defer).

## Architecture sketch

```
                browser
      ┌──────────┴───────────┐
      │ https://webpi.…      │ https://zed.…
      │  console (Astro)     │  KasmVNC web client (TLS via nginx-zed.conf)
      └──────────┬───────────┘
        nginx TLS│            │ nginx TLS
      ┌──────────┴───────┐  ┌─┴──────────────────────────────┐
      │ webpi (uid node) │  │ zed container (uid 2000)       │
      │  Astro + API     │  │  kasmvncserver :1 (X+web :6901)│
      │  /api/zed/open ──┼──┼─▶ launcher :7999 (Bearer token)│
      │  /workspace :ro  │  │   └─ setsid zed <path>          │
      └───────┬──────────┘  │  openbox (xstartup)            │
              │             │  /workspace rw ←─ webpi-workspace volume
   webpi-tmux │ socket      │  /home/workspace ← webpi-zed-home volume
      ┌───────┴──────────┐  └────────────────────────────────┘
      │ workspace uid2000│          ▲ same volume, same uid, same path
      │ tmux + pi        ├──────────┘
      └──────────────────┘
```

- `zed` + `zed-init` compose services behind the **`zed` profile** — a
  deployment that doesn't set the `WEB_PI_ZED_*` env triple never builds
  or boots any of it, and the console renders no Zed affordances
  (`ConsoleState.zed: null`).
- Config flows through the typed env system
  (`src/lib/env-schema.ts` → `src/lib/env.ts#readZedConfig`): the three
  variables are **all-or-none** (a half-set stops the server at boot,
  like object storage). `WEB_PI_ZED_URL` is the browser-facing stream
  URL and the single switch the client sees (via `/api/state` →
  `ConsoleState.zed`); the launcher pair stays server-side.
- The sidebar shows an "open in Zed" button on every past-session row
  (its `cwd`) and every live-session row (tmux
  `#{pane_current_path}`, now in `LiveSession.cwd`). The button is a
  stateless `wa-button` re-created by the 15 s innerHTML poll — the
  sidebar's transient-state rules are untouched. Click = tab opens
  synchronously (keeps the popup inside the user gesture) + the launch
  POST fires async; failures toast.

## Host-side verification (the sandbox has no docker — run these)

Everything below is UNVERIFIED in the sandbox except where marked:
statically verified there — compose.yaml parses (yaml lib), the
Dockerfile is linted by eye against the pinned releases' docs/debs (the
KasmVNC 1.5.0 deb's binary names `kasmvncserver`/`kasmvncpasswd`, its
dependency list and shipped files were read directly from the .deb;
Zed v1.23.2's asset names from the release API), `npm run check` green,
`npm run build` green, the full unit suite green (121/121 — incl. 6 new
Zed tests covering every `ZedOpenResult` code against a stub launcher),
and the e2e specs that don't render the app's wa-* pages green
(`split.spec` — which exercises the changed `listSessions` against a
real tmux server — `state-dir`, `restart`, `sessions-cache`). The rest
of the e2e suite could NOT run in the sandbox: its chromium (vendored
via LD_LIBRARY_PATH; no root for `playwright install-deps`) crashes the
renderer on any page carrying Web Awesome's declarative-shadow-DOM
templates — reproduced with plain `file://` HTML on the untouched
login page, so environmental, not this branch. The new unconfigured-
state e2e test lives in `tests/e2e.spec.ts` and must run on the host.

1. **Build + boot**
   ```sh
   ZED_VNC_PASSWORD='pick-a-stream-password' \
   WEB_PI_ZED_URL='https://zed.example.com/' \
     docker compose --profile zed up -d zed
   docker compose --profile zed logs zed      # expect: "streaming on :6901 … launcher on :7999"
   curl -fsS http://127.0.0.1:6901/ >/dev/null && echo web-client-up
   curl -fsS http://127.0.0.1:7999/healthz    # NO — launcher is not published;
                                              # from inside the compose network only:
   docker compose exec webpi node -e "fetch('http://zed:7999/healthz').then(r=>r.text()).then(console.log)"
   ```
2. **The stream**: put `deploy/nginx-zed.conf` (renamed to your Zed
   hostname) next to your nginx config, reload, open the URL, sign in
   with `kasm_user` / `ZED_VNC_PASSWORD`. Expect an openbox desktop
   (empty), and the browser window resizing the desktop
   (`xrandr` inside the container follows the client).
3. **Folder open from the console**: in web-pi, click the ⌷-icon on a
   session row. Expect: a new tab with the Zed stream; a first-boot Zed
   (llvmpipe notice in `docker compose --profile zed logs zed` /
   `~/.local/share/zed/logs/Zed.log` inside the container: `Using GPU:
   … llvmpipe …`); the session's cwd opens as a workspace. Click again
   for a second session: a second window, same instance. Kill Zed inside
   the stream (quit), click again: it re-boots with that folder.
4. **Editing round-trip as uid 2000**: create a file via the Zed UI,
   confirm it appears under `/workspace/<checkout>` owned by uid 2000,
   and that a pi session in the workspace container sees it (and vice
   versa).
5. **Clipboard both ways** (copy text out of Zed into the host, and
   host→Zed), per the KasmVNC client's clipboard prompts.
6. **Typing latency, subjective**: open a large-ish file and type. This
   is the honest-risk item (software rendering — see §1). If unusable,
   try a beefier CPU, or KasmVNC's `desktop.gpu.hw3d` with a passed-through
   `/dev/dri/renderD128`.
7. **Degradations to accept/verify**: Zed's in-app sign-in/API-key
   storage may not persist without a dbus secret service; the seeded
   settings disable auto-update (the image pins Zed — rebuild to
   upgrade).
8. **Unconfigured stays clean**: on a host that never sets
   `WEB_PI_ZED_URL`, `docker compose up -d` boots exactly as before and
   the sidebar has no Zed buttons (`grep -c data-zed` in the served page
   HTML = 0).

## Junctions for the merge

- `compose.yaml` — `zed` / `zed-init` services, `webpi-zed-*` volumes,
  and the three `WEB_PI_ZED_*` env lines under `webpi` (all marked
  `# task/zed-webapp:`). task/winston-loki adds services too: the
  comment block at the top is the only shared region.
- `src/lib/env-schema.ts` — the same three fields, marked
  `// task/zed-webapp:` (task/winston-loki is expected to meet this file
  as well).
- `src/lib/tmux.ts` — `listSessions` now uses an explicit `-F` format
  and `LiveSession` gained `cwd` (`src/lib/types.ts`): every consumer of
  the old default-format parsing is updated; check new siblings don't
  hand-parse `tmux list-sessions` output elsewhere.
- The console UI deliberately stops at per-session buttons — the TODO's
  side-tab bar (pi / zed / terminal / preview) will subsume
  `ConsoleState.zed` and the `open-zed` event when it lands.
