# web-pi

**pi in the browser.** A small, self-hostable web app that gives you
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding
sessions in a terminal in your browser — new sessions, past-session resume,
live attach — all backed by tmux so nothing is lost when the tab closes.

One Node process serves everything: the Astro SSR pages (middleware
handler), the JSON API, and a WebSocket that bridges xterm.js to tmux via
node-pty. No framework on the client — just web components, with
[Web Awesome](https://webawesome.com/) (default theme, SSR'd) as the UI
toolkit.

```
Browser (xterm.js)
   │ WSS
   ▼
web-pi server (Node, loopback by default)
   │ node-pty
   ▼
tmux socket ── session per tab ── pi ── ~/.pi/agent/sessions/
```

On a plain host that is literally one process and one unix user. The
default container deployment splits the same picture across two
containers and two uids (server vs tmux/pi) — see
[The privilege split](#the-privilege-split-two-containers).

## What you get

- **New session** — a tmux session running `pi` (command configurable);
  closing the browser tab detaches, the session keeps running. A dropped
  connection (proxy idle timeout, server restart, network blip) reattaches
  to the same tmux session on its own, with backoff.
- **Sessions** — past pi sessions parsed from pi's session store
  (`~/.pi/agent/sessions` by default), grouped by working directory, newest
  first. Click to resume: starts `pi --session <id>` at the session's
  original cwd (pi appends — history is never destroyed). Type in the
  filter box to search titles/paths; hide a session to declutter the list —
  hiding only records the id in a small server-side state file (never
  touches pi's store) and is reversible via "N hidden — manage".
- **Live** — running tmux sessions on the app's socket; click to attach
  (`attach -d`).
- **Jobs** (`/jobs`) — scheduled commands ("cron") on the built-in
  scheduler: name + 5-field cron schedule + arbitrary shell command. Every
  run — scheduler-fired or "run now" — opens in a tmux session on the app's
  socket, so it shows up in Live and is attachable like any session.
- **Settings** — `/settings`: read-only dashboard of the effective config
  (listen address, paths, versions) plus the pi update actions — a manual
  update-pi button and an opt-in daily auto-update that stays within the
  declared range.
- **File uploads** — `POST /api/files` (multipart, field `file`) stores
  the file in object storage and answers its key: any S3-compatible
  server, SeaweedFS in the compose stack ([Object storage](#object-storage-seaweedfs)).
  The building block for apps that take files; without storage
  configured it answers 503 and nothing else changes.
- **Single-user login** — username + password, salted scrypt hash in the
  sqlite state db (`webpi.db`), `HttpOnly`/`Secure`/`SameSite=Strict`
  session cookie. Sessions persist across server restarts (only token
  hashes are stored). No account machinery. Fails closed until the
  credential exists.

## Requirements

- Node ≥ 22.13 (for the built-in `node:sqlite`; plus a C++ toolchain for
  `node-pty`: build-essential / g++ / python3)
- `tmux` on PATH — pi ships as an npm dependency (`npm install` vendors it)
- Linux (node-pty + tmux; developed on Debian)

## Quick start

```sh
npm install
npm run build
npm run set-password          # interactive; writes the credential into webpi.db (0600)
npm start                     # serves on http://127.0.0.1:3000
```

Put it behind TLS (any reverse proxy) before exposing it anywhere — the
cookie is `Secure` and login POSTs shouldn't cross plain HTTP. See
`deploy/` for an nginx reverse-proxy block with WebSocket upgrade, and a
fail2ban jail for failed logins. One host only, whatever fronts it —
sessions and rate limits are in-process state and the tmux server is
host-local on the app's own socket, so there is no multi-instance/LB
shape (see [Deploying](#deploying)). Container route:

```sh
docker compose up -d        # builds the image, serves on 127.0.0.1:3000
```

## Developing

**In the container** (same image as production):

```sh
docker compose --profile dev up dev   # astro dev :4321 + API/WS :3001
```

The repo is bind-mounted into the container at `/app`; `node_modules` is a
shadow volume so the container builds its own native deps (`node-pty`)
without touching the host's. First boot npm-installs (a few minutes);
later boots self-heal in seconds. Everything is real: `webpi.db` login,
session listing, live attach — and pi sessions start in `/app` (the repo),
self-modification included. Page edits hot-reload through the bind mount.
Dev state (`webpi.db`, `pi-agent/`) lives in the container's `/tmp`
(`WEB_PI_STATE_DIR: /tmp/web-pi-state`) — throwaway: recreate the dev
service and you re-run set-password; production's `webpi-state` volume is
untouched by the profile.

Notes:
- Dev runs as `${UID:-1000}:${GID:-1000}` so the container user matches
  the host checkout's owner. Bash doesn't export `UID`/`GID` — `export
  UID GID` first (or drop `UID=$(id -u)`/`GID=$(id -g)` lines in a `.env`
  next to `compose.yaml`).
- The repo bind uses the `:z` volume flag — required on SELinux-enforcing
  hosts (relabels the tree `container_file_t`), a no-op elsewhere.
- Dev shares ports 3001/4321 with the host flow below — run one or the
  other, not both.
- The dev profile builds the `dev` image target (`web-pi:local-dev`),
  which carries `build-essential`/`python3` for the in-container
  `node-pty` build; the prod image (`web-pi:local`) stays slim.
- Uploads go to `dev-seaweedfs` (throwaway, fixed dev keys, S3 on
  loopback `:8333`), started with `dev`.

**On the host** (no docker): two processes — `astro dev` serves the pages
(HMR); the JSON API routes (`src/pages/api`) need the services the Node
server builds (they answer 503 without them), and the terminal WS and
login/logout live in the Node server itself, so the Vite server proxies
`/api`, `/ws`, and login/logout POSTs to it:

```sh
npm run dev:server   # API + WS half on :3001 (builds Astro + dist-server first)
npm run dev          # astro dev on :4321, proxying to the dev API server
```

For uploads, run the dev profile's object store and point the API half
at it (without it, `POST /api/files` answers 503):

```sh
docker compose --profile dev up -d dev-seaweedfs
WEB_PI_S3_ENDPOINT=http://127.0.0.1:8333 WEB_PI_S3_ACCESS_KEY=webpi-dev \
  WEB_PI_S3_SECRET_KEY=webpi-dev-secret npm run dev:server
```

Everything works against the dev server as it does in production. Page
edits hot-reload; an API-route edit needs a `dev:server` restart (it
serves the API from its own Astro build). The login rate limit is
in-memory: restart `dev:server` to clear it while iterating on the login
page. Override the proxy target with `WEB_PI_DEV_API`
if you run the API half elsewhere.

## Configuration (environment)

Everything is env-configured; defaults suit a single-user Linux box running
`pi` as the same user as the server. The `WEB_PI_*` contract is declared
once, typed, in a schema shared by Astro and the Node server:
`astro.config.mjs`'s `env.schema` (imported from `src/lib/env-schema.ts`)
declares every runtime variable — names, types, and the static defaults —
and the compiled server reads the same schema through `src/lib/env.ts` (the
typed runtime equivalent of `astro:env/server` for a plain-tsc build; see
the comments there for why the server can't import the Astro virtual module
directly). Number variables that aren't integers stop the server at boot.
Defaults that must be computed at boot (homedir, app-root paths, the
vendored-pi probe) live beside the reads in `src/lib/env.ts`. The one
exception is the dev-only `WEB_PI_DEV_API`, which `astro.config.mjs` reads
directly.

| Variable | Default | Meaning |
|---|---|---|
| `WEB_PI_HOST` | `127.0.0.1` | Listen address (loopback + reverse proxy is the intended shape) |
| `WEB_PI_PORT` | `3000` | Listen port |
| `WEB_PI_TRUST_PROXY` | `0` | Reverse-proxy hops in front of the server (nginx = `1`, ALB → nginx = `2`; add one per proxy stacked ahead of it). The login/WS rate limits key on the client IP that many entries from the right of `X-Forwarded-For`; the origin check also derives its scheme from the `X-Forwarded-Proto` hop it selects (see [Security model](#security-model)); `0` ignores the headers and uses the socket peer. Set it to match your proxies: too low and every client shares the proxy's bucket, too high and clients can pick their own |
| `WEB_PI_BASE` | `/` | URL base path for path-mounting on a dedicated vhost (the app wants its own hostname — [Security model](#security-model)); the files that must agree are listed in [The base path](#the-base-path). **Baked into the pages at build time** — set it before `npm run build` *and* at runtime |
| `WEB_PI_HOME` | `os.homedir()` | `HOME` for spawned processes (tmux, pi) |
| `WEB_PI_STATE_DIR` | `$WEB_PI_HOME/.local/state/web-pi` | one directory for all web-pi state: the sqlite db (`webpi.db`) and the runtime `pi-agent/` (pi credentials + sessions). Per-path overrides (`WEB_PI_DB_FILE`, `WEB_PI_AGENT_DIR`) still win. In the container compose points it at `/state` on a dedicated volume |
| `WEB_PI_AGENT_DIR` | `<state dir>/pi-agent` | runtime pi agent dir (config, credentials, sessions for spawned pi) — seeded from the repo's `pi/` template where absent (a stray `PI_CODING_AGENT_DIR` in the server's env is ignored with an error logged) |
| `WEB_PI_SESSIONS_DIR` | `PI_CODING_AGENT_SESSION_DIR`, else `<agent dir>/sessions` | where to list past pi sessions from |
| `WEB_PI_NEW_SESSION_CWD` | `$WEB_PI_HOME` | cwd for new sessions |
| `WEB_PI_COMMAND` | `<app root>/node_modules/.bin/pi` (falls back to `pi` on PATH) | command run in a new session (whitespace-split; resume appends `--session <id>` — only pi-family CLIs support that) |
| `WEB_PI_TMUX_SOCKET` | `web-pi` | the tmux socket the app uses. A relative *name* is the single-user shape: the app's own server, forked on the first new-session, under the per-uid default dir. An **absolute path** switches on the privilege split ([below](#the-privilege-split-two-containers)): tmux runs as another uid/container on that shared socket (`-S` instead of `-L` — a relative name resolves per-uid and cannot be shared), and new/resume sessions refuse to fork a server, erroring with "workspace tmux server not running" instead. The server lifecycle is then the workspace side's job (`docker-workspace-entrypoint.sh`, or the host-install equivalent below) |
| `WEB_PI_TMUX_CONF` | `<app root>/tmux.conf` | tmux server config, applied when the tmux server starts (escape-time, scrollback, truecolour — see the file) |
| `WEB_PI_DB_FILE` | `<state dir>/webpi.db` | sqlite state db (0600): login credential, `sessions` overlay table (hidden flags), scheduled-job tables (`jobs`, `job_runs` — the in-process scheduler), `settings` kv (the pi auto-update toggle + outcomes). Fresh setup: `npm run set-password` creates it |
| `WEB_PI_CLIENT_DIR` | `<app root>/dist/client` | Astro hashed assets |
| `WEB_PI_ASTRO_ENTRY` | `<app root>/dist/server/entry.mjs` | Astro SSR handler |
| `WEB_PI_S3_ENDPOINT` | *(unset: no storage)* | S3 API URL of the object store (`http://seaweedfs:8333` in compose). Unset, `POST /api/files` answers 503. Set, it needs both keys below — a half-set or non-http value stops the server at boot |
| `WEB_PI_S3_ACCESS_KEY` / `WEB_PI_S3_SECRET_KEY` | *(unset)* | the store's credentials. In compose, generated once by `seaweedfs-init` and loaded by the entrypoint — not set in `compose.yaml` |
| `WEB_PI_S3_BUCKET` | `webpi` | bucket for uploads (created on first use when missing) |
| `WEB_PI_S3_REGION` | `us-east-1` | SigV4 signing region — self-hosted servers accept any |
| `WEB_PI_DEV_API` | `http://127.0.0.1:3001` | dev only: where `astro dev` proxies `/api`, `/ws`, login/logout (the `npm run dev:server` process) |

Run under a dedicated unprivileged user (the app spawns a terminal — treat
it as a web shell by design). Don't run it as root, don't put a sudo-wielding
user behind it.

## Scheduled jobs (/jobs) — the in-process scheduler

The jobs page is cron-with-a-face: each job is a **name**, a **5-field
cron schedule** (`minute hour day-of-month month day-of-week`, validated
live in-app with [cron-parser](https://www.npmjs.com/package/cron-parser))
and an arbitrary **shell command**. Jobs live in the sqlite state db
(`jobs` table; one `job_runs` bookkeeping row per fire) and are fired by
a scheduler inside the server process — no systemd, no extra daemon, so
jobs work in every install shape, the container included.

- **Firing**: the scheduler ticks every ~30s and opens due jobs with
  `tmux new-session -d -s webpi-<name>` on the app's own socket (same
  `-f` conf, cwd and `PI_CODING_AGENT_DIR` env a main-page session
  gets). Runs therefore appear in **Live** and attach like any session —
  including runs that fired while you had no browser open.
- **Downtime catch-up**: each fire is recorded in `job_runs`; on boot the
  scheduler compares the last fire against the schedule and fires **one**
  catch-up run per job whose window passed while the server was down —
  systemd's `Persistent=true` equivalent, deliberately capped at one run
  (a job that missed three dailies runs once, not three times).
- **Run semantics**: a fire is **skipped** while the previous run's tmux
  session is still alive — long-running agent jobs don't pile up. "Run
  now" checks and returns 409 in that case. Deleting a job removes its
  definition and run history but deliberately leaves a live run's
  session alone.
- The trade-off vs the old systemd timers: nothing fires while web-pi
  itself is down (hence the catch-up above). Job commands run as the
  web-pi user, on the app's socket, per the security model — the terminal
  is the product.

## Pi: dependency & config isolation

pi is a versioned dependency (`@earendil-works/pi-coding-agent` in
`package.json`; the vendored binary is logged at boot), not something
installed on the box. Its config is project-controlled too:

- [`pi/`](pi/) in the repo is the **template** — settings, `mcp.json`,
  skills, extensions; whatever the install should ship to every session.
- The **runtime agent dir** (default `<state dir>/pi-agent`) is
  seeded from it **only where absent**: existing files always
  win, so settings pi itself writes and operator edits are never clobbered,
  while template files added by upgrades still land. State only pi writes
  (`auth.json`, `sessions/`) is never in the template. The seeder is
  whoever owns the dir: the server at boot in single-user shapes, the
  workspace entrypoint in the split (so every file lands uid-2000-owned).
- Spawned sessions run with `PI_CODING_AGENT_DIR=<runtime dir>` (delivered
  via `tmux new-session -e`, deterministic per session) — they never touch
  your `~/.pi/agent`, in either direction.

Consequences: web-pi sessions don't see credentials already in your global
pi config — `/login` once inside a session (or seed the runtime
`auth.json`); past sessions from `~/.pi/agent/sessions` don't show in the
sidebar unless you point `WEB_PI_SESSIONS_DIR` there.

## Deploying

One host, one instance, everywhere web-pi runs. It is single-user and
single-instance by design — sessions and the login/WS rate limits are
in-process state, and the tmux server is host-local on one shared socket
(in a container: the workspace container's) — so there is no
multi-instance or load-balanced shape: run exactly one instance behind
one proxy. The
recommended deployment is a single VPS with Docker compose; on AWS, the
documented path is the same compose setup on a single EC2 instance —
state lives on the instance's own disk, and it is replaced only when you
deploy.

```sh
docker compose build        # subpath deploy: 'The base path' below first — WEB_PI_BASE=/webpi docker compose build
docker compose up -d        # web + workspace + seaweedfs + one-shot inits; loopback :3000, TLS reverse proxy in front
docker compose exec webpi node dist-server/server/set-password.js   # once, on a fresh deploy
```

### The privilege split (two containers)

`docker compose up` boots three services from one image (prod shape of
[DESIGN_REVIEW.md](DESIGN_REVIEW.md) §1.1):

- **webpi** (uid `node`, the image's user) — serves the HTTP/WS app from
  the image's copy at `/opt/web-pi`, which is **root-owned**: a prompt
  injection inside a pi session can no longer rewrite the server, replace
  the login credential, or plant persistence in it. Owns web state
  (`webpi.db`) on the `webpi-state` volume at `/state`. Never runs the
  tmux server — it is only a client on the shared socket.
- **workspace** (uid 2000, user `workspace`) — owns the tmux server and
  every pi session. Its entrypoint (`docker-workspace-entrypoint.sh`)
  starts the tmux server on the shared absolute-path socket
  `/run/web-pi/tmux` with `exit-empty off` (so it survives between
  sessions — web's never-fork guard depends on it), `chmod 0660` +
  `chgrp webpi` on the socket (tmux creates it 0600 regardless of umask),
  admits the web user with `tmux server-access -a node`, seeds the runtime
  pi-agent from the image's `pi/` template (only where absent — same
  policy as the single-user server boot), and supervises the server.
  Sessions' working files live on the `webpi-workspace` volume at
  `/workspace` (cwd of new sessions, `WEB_PI_NEW_SESSION_CWD`); pi's
  runtime dir (`WEB_PI_AGENT_DIR=/workspace/pi-agent`, credentials +
  session store) is there too.
- **workspace-init** (one-shot, root) — `chown workspace:webpi` +
  `chmod 2770` on the socket dir (`webpi-tmux` volume at `/run/web-pi`)
  and `/workspace`: empty named volumes start root-owned, and the socket
  dir must be setgid group `webpi` (gid 2001) for the sharing below.

The two halves share a `webpi` group (gid 2001; `node` is a member, it is
`workspace`'s primary group). The workspace side runs with **umask 0007**,
which the tmux server passes on to everything it spawns: pi's session
files land group `webpi` and group-readable, so the web sidebar can list
and resume past sessions (web mounts `/workspace` read-mostly — it never
writes there; hidden flags live in its own db). Cross-uid tmux access is
what `server-access` grants: without an entry the foreign-uid client gets
a hard "access not allowed"; with it, full client access on the socket.

Path agreement matters in this shape: `WEB_PI_COMMAND` (default: the
image's vendored `/opt/web-pi/node_modules/.bin/pi`) and the session cwd
resolve **in the workspace container** — both containers use the same
image and mount the shared volumes at the same paths, so the defaults
hold. Scheduled jobs are unchanged: the scheduler fires `new-session` on
the same shared socket (same guard, same env), so runs land in the
workspace container too and appear in Live like any session — a job only
runs while the web server is up, exactly as before.

The pre-split `webpi-app` volume (the entrypoint-synced `/app` the server
served from) is obsolete — web serves from the image now — and is left in
place, unused, on existing hosts.

### Object storage (SeaweedFS)

Uploads (`POST /api/files`) go to an S3 bucket through the AWS SDK
(`src/lib/storage.ts`). Nothing in the app is specific to one server; the
compose stack runs [SeaweedFS](https://github.com/seaweedfs/seaweedfs)
(`weed mini`, pinned) — MinIO's community edition was archived in 2026
and its images are gone. Two more services:

- **seaweedfs** — S3 API on `seaweedfs:8333`, data on the `webpi-seaweedfs`
  volume. It sits on the `storage` network (`internal`: no route out)
  with **webpi only**: the workspace container, where pi sessions run,
  cannot reach it, and it publishes no port. That network is the
  boundary that matters — besides S3, `weed mini` runs filer/master/gRPC
  ports with no auth of their own. Everything but the S3 API (admin UI,
  WebDAV, Iceberg/Lance catalogs) is switched off, and so is its
  telemetry, which is on by default.
- **seaweedfs-init** (one-shot, root) — on the first `up`, generates the
  S3 key pair into `credentials.env` on the `webpi-s3-credentials` volume
  (mounted read-only into both). `docker-entrypoint.sh` loads it for the
  server; the seaweedfs wrapper hands it to `weed` as its admin identity.
  Later `up`s keep it. Back up `webpi-seaweedfs` and
  `webpi-s3-credentials` together.

The app creates the bucket (`WEB_PI_S3_BUCKET`) on first upload. To use
another S3-compatible store (S3, R2, Garage, …) instead, point
`WEB_PI_S3_ENDPOINT` and the two keys at it and drop the seaweedfs
services. Uploads are capped at 10 MiB and a small set of inert types
(`src/schemas/uploads.ts`); keys are `uploads/<uuid>`, stored with the
client's file name as an `attachment` Content-Disposition.

#### The same split on a plain host (two unix users)

A host install (npm package or checkout) can have the same guarantee
without Docker — run the server and the sessions as different users over
one shared socket. Once, as root:

```sh
groupadd -g 2001 webpi
useradd -u 2000 -g webpi -m web-pi-work     # the sessions' user
usermod -aG webpi <your-user>               # the server's user joins the group
install -d -o web-pi-work -g webpi -m 2770 /run/web-pi   # socket dir: setgid, shared group
```

Then, **as `web-pi-work`**, own the tmux server (umask 0007 makes
everything it spawns group-readable — that is what lets the server's
user list pi sessions; `exit-empty off` must ride the server-start conf,
because a separate `set-option` races the empty server's instant exit —
same reason `docker-workspace-entrypoint.sh` composes the conf):

```sh
sudo -u web-pi-work sh -c 'umask 0007; \
  { cat <app>/tmux.conf; echo "set -g exit-empty off"; } > /tmp/webpi-tmux.conf && \
  tmux -S /run/web-pi/tmux -f /tmp/webpi-tmux.conf start-server && rm -f /tmp/webpi-tmux.conf && \
  chmod 0660 /run/web-pi/tmux && chgrp webpi /run/web-pi/tmux && \
  tmux -S /run/web-pi/tmux server-access -a <your-user>'
```

(/run is wiped on boot — repeat the server bring-up from your boot
scripts, or put the socket on persistent storage. Nothing seeds the
pi-agent template in this shape — the single-user server-boot seeding is
off with an absolute socket — so copy the repo's `pi/` into the runtime
agent dir yourself, as `web-pi-work`, if you want the shipped defaults.)
And run the server itself, as your user, with the split env —
`WEB_PI_TMUX_SOCKET=/run/web-pi/tmux`, a sessions cwd and
`WEB_PI_AGENT_DIR` that exist and are writable for `web-pi-work`, and
`WEB_PI_HOME` pointing at a home that user can write. The server then
attaches and creates sessions on `web-pi-work`'s server as a cross-uid
client, exactly like the web container does.

Boxes that shouldn't build can pull instead: tags `v*` publish the prod
image to `ghcr.io/<owner>/web-pi` (the version + `latest`):

```sh
docker login ghcr.io                     # GHCR packages are private by default
WEB_PI_IMAGE=ghcr.io/<owner>/web-pi:latest docker compose pull webpi
WEB_PI_IMAGE=ghcr.io/<owner>/web-pi:latest docker compose up -d
```

`pull` before `up -d`, in that order: with `WEB_PI_IMAGE` set but no image
pulled, `up -d` falls back to building locally and *tags the build as the
registry ref* — silently shadowing the published image. (The inverse habit
— bare `docker compose pull` with `WEB_PI_IMAGE` unset — fails: `web-pi:local`
is not a registry ref. Nothing is lost; build as above instead.) With
`WEB_PI_IMAGE` unset, compose builds and runs `web-pi:local` as above.
The pulled image's `WEB_PI_BASE` was baked at build time — a subpath deploy
must pull an image built with the same base.

Or skip Docker: the npm package is a deploy channel too —

```sh
npm i -g web-pi
webpi-set-password              # interactive; creates webpi.db
web-pi                          # serves on http://127.0.0.1:3000
```

— same `WEB_PI_*` env contract, loopback bind by default, behind the same
reverse proxy (below). Nothing lands inside the installed package dir:
all state defaults under `$WEB_PI_HOME/.local/state/web-pi`
(`WEB_PI_STATE_DIR` moves it — see the env table). The /settings
`update pi` button runs `npm install` in the install dir — on a
root-owned global prefix that fails with EACCES; update by
`npm i -g web-pi@latest` there instead. Requirements as above: Node
≥ 22.13, a C++ toolchain to build `node-pty`, `tmux` on PATH.

Front it with TLS — [`deploy/`](deploy/) has:

- `nginx-webpi.conf` — TLS reverse proxy with the WebSocket upgrade map
  (upstream is the published loopback port). One proxy hop, so the server
  runs with `WEB_PI_TRUST_PROXY=1` (compose sets it; set it yourself for a
  host install behind nginx)
- `fail2ban-filter-webpi.conf` + `fail2ban-jail.conf` — fail2ban watching
  the nginx access log for failed logins (401/429 on the login POST) and
  failed /management password re-confirmations (401/429 on the management
  build/activate POSTs)

State is split by owner, like everything else in the two-container shape:
`webpi.db` (login credential, hidden sessions, jobs) lives on the
`webpi-state` volume at `/state` (`WEB_PI_STATE_DIR`), owned by the web
uid; `pi-agent/` (pi credentials + sessions) lives on `webpi-workspace`
at `/workspace/pi-agent`, owned by the workspace uid. There is deliberately
no migration system — move once by hand, and the move depends on the era
you installed from. Current installs (state already on `/state`:
`webpi.db` stays put, `pi-agent/` crosses to the workspace volume):

```sh
docker compose down
docker compose build   # the new users exist only in the NEW image — build first
docker compose run --rm --user 0:0 --volume webpi-state:/state --entrypoint sh workspace -c \
  'mv /state/pi-agent /workspace/pi-agent && chown -R 2000:2001 /workspace/pi-agent'
docker compose up -d
```

(`run` goes through the **workspace** service — its `/workspace` mount is
read-write, while webpi's is `:ro`; `--volume` adds the state volume it
doesn't otherwise carry.) Older installs (state sat on the now-unused
`webpi-app` volume under `/app`) move both halves:

```sh
# container: state sat on the (now unused) webpi-app volume under /app
docker compose down
docker compose build   # the new users + node-owned /state exist only in the NEW image — build first
docker compose run --rm --user 0:0 --volume webpi-app:/old-app --volume webpi-state:/state --entrypoint sh workspace -c \
  'mv /old-app/webpi.db /state/webpi.db && mv /old-app/.pi-agent /workspace/pi-agent && chown node:node /state/webpi.db && chown -R 2000:2001 /workspace/pi-agent'
docker compose up -d
```

A host install is the same move against the default dir, server stopped:
`mkdir -p ~/.local/state/web-pi && mv <app root>/webpi.db
~/.local/state/web-pi/ && mv <app root>/.pi-agent
~/.local/state/web-pi/pi-agent`. A fresh deploy
needs none of this — just re-run `npm run set-password`.

The old systemd unit is gone: the container *is* the unit (restart policy
in compose; healthcheck ships in the image; `ProtectSystem`-style
hardening is the container boundary). nginx in front, fail2ban from day
one — the same shape on a VPS and on EC2.

**Web restarts no longer end live sessions; workspace restarts still do.**
tmux lives in the workspace container, so a web-pi deploy, crash or OOM
leaves every session running (open terminals get the `restart` message,
reconnect, and reattach to the same tmux sessions — nothing died; login
sessions live in the state db, so nobody has to sign in again). Any
*workspace* container stop (crash, OOM, host reboot, deliberate
`docker compose stop workspace`) kills the running sessions with it. A
*deliberate* stop is still graceful for the web half: every open terminal
gets a `restart` message and shows "server restarting — reconnecting",
the server exits 0 within ~5 s. Recovery after a workspace loss is the
sidebar's resume: nothing is lost — every session, finished or not,
stays listed from pi's session store, and clicking it continues it
(`pi --session <id>` appends — the transcript outlives the dead tmux
session). If the workspace container is merely slow to boot (or the
socket is missing), new/resume report "workspace tmux server not running"
instead of silently forking a server on the web side — retry once the
workspace service is up.

### The base path

`WEB_PI_BASE` (default `/`) is baked into the pages at build time and read
again at runtime, while nginx and fail2ban only ever see URLs — so one
value has to be kept in agreement, by hand, in exactly three files. The
canonical example is `/webpi`, and each file below carries that value at
a single definition point:

- **[`compose.yaml`](compose.yaml)** — the `WEB_PI_BASE` variable (in the
  shell env, or a `.env` next to the file). Compose interpolates that one
  variable into both the build arg and the runtime env, so the image and
  the server can't drift apart on their own.
- **[`deploy/nginx-webpi.conf`](deploy/nginx-webpi.conf)** — the named
  capture at the head of the location regex, the file's only occurrence
  (marked with a comment; `proxy_pass` forwards the client's path
  unchanged, so the one literal both selects and names the prefix).
- **[`deploy/fail2ban-filter-webpi.conf`](deploy/fail2ban-filter-webpi.conf)**
  — the POST paths inside `failregex` (the login POST and the management
  re-auth POSTs), likewise the file's only occurrences; the NOTE above it
  points here and at the nginx capture.

Change it at all three definition points, then rebuild the image (it's
baked in — `docker compose build`), reload nginx, and restart fail2ban.
A *pulled* image bakes the base at its own build time in CI instead —
and today the release workflow publishes base-`/` images only, so a
subpath pull means forking it (or building locally). A host/npm install
replaces bullet 1 with the plain `WEB_PI_BASE` build-time + runtime env
(no compose variable). With the default `/` — web-pi on its own hostname
— none of this applies: proxy `location /` and the filter's POST path
are `/` and `/login`.

### Updating

**pi** — where from depends on the install shape:

- **Split containers (the compose default):** sessions run the image's
  vendored pi, so updating pi is updating the image: `npm install
  @earendil-works/pi-coding-agent@latest` in your checkout, `docker
  compose build && docker compose up -d`. The workspace container picks
  the new binary up on the next `up` (pi is exec'd per session; running
  sessions finish on the old one). Durable in-place updates without a
  rebuild: install pi standalone on the workspace volume and point
  `WEB_PI_COMMAND` at it — pi's own dependency tree is pure JS (verified:
  installs and runs with no compiler on PATH), unlike a full web-pi
  checkout whose `npm install` would build `node-pty`:

  ```sh
  docker compose exec workspace sh -c 'mkdir -p /workspace/pi && cd /workspace/pi && npm init -y >/dev/null && npm install @earendil-works/pi-coding-agent@latest'
  # compose webpi environment: WEB_PI_COMMAND=/workspace/pi/node_modules/.bin/pi
  docker compose up -d
  ```

  `/settings` in this shape reports the image's vendored version; drift
  there means the workspace copy moved ahead.
  <!-- JUNCTION task/pi-auto-update: an auto-update setting on /settings
       lands here — in the split shape the update TARGET is the
       workspace-side pi (image flow or the standalone install above),
       not the web container's read-only /opt/web-pi; in single-user
       shapes it stays the in-place npm install described below. -->
- **Single-user shapes (host install, npm global, the dev profile):**
  `npm install @earendil-works/pi-coding-agent@latest` in the install
  dir, or click **update pi** on `/settings` — the server runs that same
  install in the app's install dir and shows the captured npm output and
  the resulting version. No restart is needed: pi is exec'd per session;
  running sessions finish on the old one. Concurrent updates are refused;
  npm missing from the server's PATH is reported instead of
  installed-around. (In the **docker dev profile** `node_modules` is a
  shadow volume and `npm install` re-runs from the lockfile on every
  boot, so an update made in place does not persist there.)

Stay within the `^1` range web-pi declares (its session-listing and resume
code is written against that major).

**Auto-update** (`/settings`, default off): a `wa-switch` next to the
manual button turns on a daily check — the server checks about a minute
after boot (or after you flip the switch) and then every 24 h while it
runs. Unlike the manual button's `@latest`, auto-update always targets the
**newest version within the range web-pi declares** in its `package.json`
(e.g. `npm install @earendil-works/pi-coding-agent@^1.0.1` — the range is
derived from the declaration, never hardcoded), so it can never carry you
outside that major; a pi you installed by hand *above* the range is left
alone (latest-in-range < installed means no update — it never downgrades
back into range). Installs go through the same machinery as the button
(shared one-at-a-time guard, captured output, no restart), always in the
install dir the server runs from. `/settings` shows the last check and
last update outcomes; if the declared range can't drive auto-update or npm
is missing from the server's PATH, the check says so instead of installing
anything.

Which install dir that is depends on the shape. In the **single-user
shapes** (host install, npm global) it is the install dir sessions run pi
from, and auto-update moves them as described above. In the **split
containers** (the compose default) the server runs from the web
container's `/opt/web-pi` — not the workspace side the sessions run pi
from — so an auto-update there only moves the copy `/settings` reports,
and it survives only until the next image deploy; use the image or
standalone-workspace flows above to change what sessions actually run.
Sending the auto-update install to the workspace side is a marked junction
in `src/lib/auto-update.ts` for a later pass. In the **docker dev
profile** `node_modules` is a shadow volume and `npm install` re-runs
from the lockfile on every boot, so nothing auto-updated persists there.

**App code:** rebuild + `up -d` — the web container serves the image's
`/opt/web-pi` copy, so an image rebuild IS the deploy; nothing syncs a
running copy anymore. Volumes (`webpi-state`, `webpi-workspace`) never
re-seed when image content changes.

**Git-owned checkout (self-modification, durable local edits):** the
image copy is root-owned by design — pi sessions can't edit it, they edit
a checkout in the workspace instead. That is the self-modification story:
pi edits `/workspace/<checkout>`, and a future web-side apply step (the
management-page TODO) builds and swaps what web serves. To work that way
today, keep a checkout on the workspace volume (building it is a dev-image
or host concern — the slim workspace container has no compiler):

```sh
docker compose exec workspace git clone <your-fork> /workspace/web-pi
```

Sessions keep running the image's vendored pi (or the standalone install
above — point `WEB_PI_COMMAND` at either); the checkout is the tree pi
edits and the future apply step builds from.

## Security model

- The terminal **is** the product: anyone with the session cookie can type
  into a shell as the sessions' user. One user, strong password, TLS,
  fail2ban, loopback bind + reverse proxy. Rate limits: 10 login POSTs / 15 min / IP,
  30 WS connections / min / IP (in-memory), where the IP is the socket peer
  or, behind proxies, the `X-Forwarded-For` hop `WEB_PI_TRUST_PROXY`
  selects — never the client-supplied leftmost entry. Password hashing runs
  off the event loop, at most 4 at once (more get 503), so a login flood
  can't stall attached terminals.
- Login sessions last 7 days idle and at most 30 days from sign-in. They
  persist in the state db (`auth_sessions`, file mode 0600) as SHA-256
  hashes of the cookie token, never the token itself, so a copied db or
  backup can't sign anyone in, and a server restart doesn't sign anyone
  out. "Log out everywhere" (`/settings`) and a password change
  (`npm run set-password`) revoke every session; open terminals end
  within 30 s. The login rate limiter stays in memory (a restart resets
  it).
- **Serving and working are privilege-split by default in containers**
  ([DESIGN_REVIEW.md](DESIGN_REVIEW.md) §1.1): pi reads untrusted input
  (repos, web pages, tool output), so a prompt injection must not be able
  to rewrite the server or replace the login credential. In the compose
  shape the server runs as uid `node` off a root-owned `/opt/web-pi` and
  never owns the tmux server; sessions run as uid 2000 in the workspace
  container and cannot reach the server's state at all — web's
  `/workspace` mount is its read-only view of the *sessions'* store
  (sidebar/resume), not a bridge in the other direction, and the login
  db on `/state` is mounted only on the web container. Host installs get
  the same guarantee from the two-user setup below; a single-user install
  (npm global, dev profile, `WEB_PI_TMUX_SOCKET` left relative) keeps the
  simpler one-uid shape and its one-uid blast radius.
- Auth fails closed: no credential file → no login possible.
- **Give web-pi its own hostname.** `WEB_PI_BASE` is for path-mounting on
  a dedicated vhost (`webpi.example.com/webpi`), not for riding an
  existing site: on a shared host every same-origin XSS — anywhere on that
  host — reads this app's responses and drives the terminal, and on this
  app a shell is the product. A cookie `Path` is no boundary to
  same-origin scripts.
- **Origin checks:** every non-GET request with a present-but-mismatched
  `Origin` is rejected (403) before anything else runs; requests without
  an `Origin` (curl, API clients) pass. WebSocket upgrades must carry a
  matching `Origin` at all — there is no Origin-free path, so no
  curl/websocat terminals and no cross-site WebSocket hijacking from a
  sibling subdomain (same-site but not same-origin — the defence
  `SameSite=Strict` doesn't provide). The expected origin is derived per
  request from `Host` + `X-Forwarded-Proto`, the latter honoured only when
  `WEB_PI_TRUST_PROXY` trusts it (same right-most-hop selection as the
  rate limits' `X-Forwarded-For` reading). Each proxy hop must *forward*
  the original `X-Forwarded-Proto`, never replace it — nginx behind a
  TLS-terminating front (ALB) must pass `$http_x_forwarded_proto`
  through, not `$scheme`: a replaced proto disagrees with the browser's
  `Origin` and the app fails closed (403s), by design.
- **Security headers** on every response the app itself sends (pages,
  assets, API, redirects, upgrade rejections — host installs get them
  without nginx): CSP `default-src 'self'; script-src 'self'; style-src
  'self' 'unsafe-inline'; connect-src 'self' wss:; frame-ancestors
  'none'` (Astro bundles all scripts as same-origin modules; xterm and
  Lit inject styles at runtime, hence the style exception), plus
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`. The Web Awesome icon glyphs are vendored
  into `public/icons/wa/` and resolved from there client-side — nothing
  loads from the Font Awesome CDN, so the strict CSP holds and no usage
  leaks to a third party.
- Static assets are served from a fixed route table with traversal checks;
  request bodies are size-capped: 10 KiB everywhere except an upload to
  `POST /api/files` (10 MiB + multipart envelope). `server/main.ts`
  refuses an oversized `Content-Length` (413) — and a length-less
  chunked body (411) off the upload route — before Astro reads a byte;
  the adapter's `bodySizeLimit` (the upload cap) backstops a stream.
- Object storage is reachable only from the web container (compose's
  internal `storage` network), with generated credentials; uploads are
  stored as `attachment`s and limited to types that are inert if ever
  served back (no HTML, no SVG).
- Past-session previews read only file heads (first user message, capped at
  64 KiB per file, 200 files).

## Project shape

- `src/pages`, `src/layouts` — Astro pages (login + app shell), SSR'd
- `src/layouts/Base.astro` — Web Awesome default theme + global styles
  (astro-lit hydration support is imported by each component script —
  import order vs wa-* modules matters, see AGENTS.md)
- `src/components` — web components: `<console-app>`, `<session-sidebar>`,
  `<agent-terminal>` (xterm.js island); each static shell is SSR'd by an
  Astro wrapper (`ConsoleApp.astro`, `AgentTerminal.astro`)
- `src/lib` — shared strict TS: auth (scrypt + persisted sessions + rate
  limiter), tmux helpers, pi session-store parser, scheduled jobs
  (in-process scheduler), wire types, typed env schema + reads
  (`env-schema.ts` / `env.ts`, the `WEB_PI_*` contract); `services.ts`
  (the stateful services the server hands Astro in `locals`); `web/` —
  request parsing, Result→Response mapping, locals narrowing
- `src/pages/api` — the JSON API as thin Astro routes (parse → one
  service call → response), only reachable through the server's
  origin + session gate (`src/middleware.ts` fails closed without it)
- `src/pages/partials` — server-rendered fragments (the jobs list, the
  settings data) that the /jobs and /settings elements swap in to
  refresh; same gate, never cached by the service worker
- `src/schemas` — node-free zod schemas shared by server and browser
  (request bodies, WS frames, branded IDs); `src/types` — the `Result`
  contract and branded ID types. Conventions: `docs/CODE_STYLE.md`
- `server` — the Node server: origin + session gate, login/logout,
  assets, the Astro SSR handler (pages + API), WS → node-pty → tmux
- `src/pages/jobs.astro` + `src/components/JobsApp/` — the scheduled-jobs
  page (list/create/edit/run/delete, cron validation)
- `pi/` — the controlled pi agent-dir template (settings, MCPs, skills,
  extensions) seeded into the runtime dir; `tmux.conf` at the root is the
  tmux server config — together they're the shipped "environment config"
- `Dockerfile`, `docker-entrypoint.sh`, `docker-workspace-entrypoint.sh`,
  `compose.yaml` — one image, two prod roles (web: serves root-owned
  `/opt/web-pi`; workspace: uid 2000, owns tmux + pi) + the slim prod
  default and toolchain dev targets
- `.agents/skills/` — Web Awesome docs as pi skills: `webawesome` (component
  API reference) + `webawesome-design` (layout/theming/tokens), copied
  version-locked from the installed package by `tools/build_webawesome_skills.py`
  — rerun it after bumping `@awesome.me/webawesome`

Using Web Awesome in a page (SSR pattern — server import in frontmatter,
client import in a `<script>` so it hydrates):

```astro
---
import '@awesome.me/webawesome/dist/components/button/button.js';
---
<wa-button>go</wa-button>
<script>
  import '@awesome.me/webawesome/dist/components/button/button.js';
</script>
```

## License

MIT — see [LICENSE](LICENSE).
