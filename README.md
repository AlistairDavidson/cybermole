# web-pi

**pi in the browser.** A small, self-hostable web app that organises
your work into **apps → workspaces → terminal tabs** — one tmux session
per tab, so nothing is lost when the browser tab closes — plus a
VSCodium editor tab per workspace, and
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
itself a keystroke away in any terminal (pi stays a vendored dependency;
you run it by hand whenever you want an agent).

One Node process serves everything: the Astro SSR pages (middleware
handler), the JSON API, and a WebSocket that bridges xterm.js to tmux via
node-pty — and reverse-proxies the editor (HTTP + WebSockets) at the same
origin, behind the same session gate. No framework on the client — just
web components, with
[Web Awesome](https://webawesome.com/) (default theme, SSR'd) as the UI
toolkit.

```
Browser (xterm.js tabs + the editor iframe)
   │ WSS
   ▼
web-pi server (Node, loopback by default)
   │ node-pty               /editor/* ─▶ VSCodium reh-web (uid 2000,
   ▼                        same origin, behind the session gate)
tmux socket ── one session per terminal tab
```

On a plain host that is literally one process and one unix user. The
default container deployment splits the same picture across two
containers and two uids (server vs tmux/terminals) — see
[The privilege split](#the-privilege-split-two-containers).

## What you get

- **Workspaces & apps** — the sidebar *is* the app switcher: workspaces
  grouped by app, the Console group first, a filter on workspace name,
  `+ workspace` per group, `+ app` at the bottom. A workspace is a working
  context: a cwd + terminal tabs + one editor tab.
- **Terminals** — one tab = one tmux session. New tabs run `WEB_PI_COMMAND`
  (default a login shell; pi or anything else by hand); closing the
  browser tab detaches, the session keeps running. A dropped connection
  (proxy idle timeout, server restart, network blip) reattaches to the
  same tmux session on its own, with backoff. Tabs carry live dots; a tab
  whose session died (a workspace-container loss) respawns fresh at the
  workspace cwd on its next attach — the tabs and structure always
  survive. Any tab is deep-linkable (`/?t=<terminal uuid>`).
- **Editor** — a VSCodium (reh-web) tab per workspace: self-hosted VS
  Code in the browser with server-side files, served same-origin through
  web-pi's `/editor` proxy behind the session gate — every tab opens its
  workspace's cwd (`?folder=`), many folders at once
  ([docs/editor-webapp.md](docs/editor-webapp.md)). Ships in the compose
  stack (`WEB_PI_EDITOR_UPSTREAM` defaults on in compose; empty = off).
- **Jobs** (`/jobs`) — scheduled commands ("cron") on the built-in
  scheduler: name + 5-field cron schedule + arbitrary shell command,
  optionally tagged with an app. Every run — scheduler-fired or "run now"
  — opens in a tmux session on the app's socket *and* persists a durable
  log + exit code; the jobs page shows run history with a log-tail
  viewer, and a live run is viewable in the console via `/?run=`. The
  whole surface is agent-operable too — the same jobs over an internal
  unix-socket API drive the `webpi` CLI and in-session MCP tools, and a
  seeded workspace-root `AGENTS.md` hands the root agent the
  conventions (the jobs section below tells it as one story)
- **Settings** — `/settings`: read-only dashboard of the effective config
  (listen address, paths, versions) plus the pi update actions — a manual
  update-pi button and an opt-in daily auto-update that stays within the
  declared range.
- **File uploads** — `POST /api/files` (multipart, field `file`, up to
  5 GiB) streams the file into object storage and answers its key;
  `GET /api/files/<key>` streams it back as a resumable download (Range /
  If-Range, HEAD). Any S3-compatible
  server — SeaweedFS in the compose stack ([Object storage](#object-storage-seaweedfs)).
  The building block for apps that take files; without storage
  configured both answer 503 and nothing else changes.
- **Observability** — all operational logging through one winston logger
  (readable console always); an opt-in compose profile adds Loki + Grafana
  so the same lines are queryable and kept for 14 days
  ([Observability](#observability-logs--loki-dashboards--grafana)).
- **Single-user login** — username + password, salted scrypt hash in the
  sqlite state db (`webpi.db`), `HttpOnly`/`Secure`/`SameSite=Strict`
  session cookie. Sessions persist across server restarts (only token
  hashes are stored). No account machinery. Fails closed until the
  credential exists.

## The console — apps, workspaces, terminal tabs

The main pane shows the selected workspace's **terminal tabs** (title or
"term N", a live dot, a close button) with a `+` to open another — each
tab one tmux session on the app's socket, one WS; switching tabs hides
the others but keeps them attached (state and scrollback persist, like
tmux detach). The **editor tab** (pinned last) iframes the workspace's
cwd through the `/editor` proxy — rendered only when the editor is
configured. No workspace selected: a prompt to create one. Deletion is
always a confirming dialog; deleting an app or workspace kills its
terminals' tmux sessions best-effort (job runs are never owned by
anything — an app delete just un-tags its jobs).

The surface behind it: `GET /api/state` — the 15 s poll every open tab
runs — serves the workspace tree (apps, workspaces with their terminals
and live flags, plus `editor` on/off, `defaultCwd` and each app's own
`cwd`). The rest are thin Astro routes: `POST /api/apps` (an optional
`cwd` — where workspaces under the app start) + `PATCH`/
`DELETE /api/apps/:slug` (the patch also renames and/or sets/clears
the cwd); `POST /api/workspaces` — no `cwd` on the wire: the server
derives it (the parent app's `cwd` when it has one, else
`WEB_PI_NEW_SESSION_CWD`; whatever wins must be an existing absolute
dir) + `PATCH`/`DELETE /api/workspaces/:id`; `POST
/api/workspaces/:id/terminals` (the row survives a failed spawn — the
tab renders not-live and the first attach retries it) + `PATCH`/
`DELETE /api/terminals/:id`. The terminal WS attaches in two modes:
`terminal` (a tab's uuid — respawns the session at the workspace cwd
when tmux died; reconnects re-send the frame they started with) and
`run` (a live job run's session — never respawns); input and resize
frames are unchanged. On attach the server sends one `backfill` frame
ahead of any output — the pane's scrollback history captured with
`tmux capture-pane` (history only; the client writes it under the attach
redraw), so a reattached tab has searchable history — Ctrl+F / Cmd+F
opens the pane's find bar (@xterm/addon-search). Deep links: `/?t=<terminal uuid>` opens that
tab's workspace with it selected; `/?run=<session name>` attaches a
live job run (the jobs page's "view" button).

## Requirements

- Node ≥ 22.13 (for the built-in `node:sqlite`; plus a C++ toolchain for
  `node-pty`: build-essential / g++ / python3)
- `tmux` on PATH — pi ships as an npm dependency (`npm install` vendors it)
- Linux (node-pty + tmux; developed on Debian)

## Quick start

Docker is the run shape — `npm start` and `npm run dev` drive the compose
stack (on hosts without docker, see [Developing](#developing) for the
bare `dev:server` path and [Deploying](#deploying) for the host install):

```sh
npm start                     # = docker compose up -d --build — web + workspace
                              #   + editor + seaweedfs + one-shot inits,
                              #   serving on http://127.0.0.1:3000
docker compose exec webpi node dist-server/server/set-password.js   # once, fresh deploy
```

Put it behind TLS (any reverse proxy) before exposing it anywhere — the
cookie is `Secure` and login POSTs shouldn't cross plain HTTP. See
`deploy/` for an nginx reverse-proxy block with WebSocket upgrade, and a
fail2ban jail for failed logins. One host only, whatever fronts it —
sessions and rate limits are in-process state and the tmux server is
host-local on the app's own socket, so there is no multi-instance/LB
shape (see [Deploying](#deploying)).

## Developing

One command runs the whole app for development — every dev container,
every parameter set (the app, the editor, object storage, the one-shot
inits), logs streaming to your terminal:

```sh
npm run dev    # = docker compose --profile dev up --build dev
               #   → http://127.0.0.1:3001 — Ctrl-C stops the stack
```

On a fresh state db, set the throwaway login once (in a second terminal,
while `npm run dev` is attached):

```sh
docker compose --profile dev exec dev npm run set-password
```

What that command brings up:

- **dev** — the app, built from the same repo's `dev` image target, with
  the checkout bind-mounted at `/app` (`node_modules` is a shadow volume
  so the container builds its own native deps — first boot npm-installs
  for a few minutes, later boots self-heal in seconds). One server:
  `dev:server` builds, serves `:3001`, and rebuilds + restarts on change
  — everything renders exactly as production does. Everything is real:
  `webpi.db` login, the workspace tree, live attach — new workspaces
  under an app with its `cwd` set to `/app` (the repo) start there, so
  terminals work in the checkout.
- **dev-editor** — the editor, ON by default: the same image as prod's
  `editor` but as the *host* uid over the same `/app` bind, so the editor
  tab opens the checkout dev workspaces live in and writes it as its
  owner (prod's uid-2000 editor edits the `webpi-workspace` volume
  instead — path + uid agreement is per shape). Boot dev without it by
  setting `WEB_PI_EDITOR_UPSTREAM=` empty in `.env`.
- **dev-seaweedfs** — uploads (throwaway, fixed dev keys, S3 on loopback
  `:8333`), plus the one-shot `dev-init`/`dev-editor-init` chowns.

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
- Dev shares port 3001 with the host flow below — run one or the other,
  not both.
- The dev profile builds the `dev` image target (`web-pi:local-dev`),
  which carries `build-essential`/`python3` for the in-container
  `node-pty` build; the prod image (`web-pi:local`) stays slim.

The dev loop is `dev:server`'s watch: it rebuilds on changes to `src/`,
`server/`, `public/`, the tsconfigs, `astro.config.mjs` and restarts —
an edit appears on `:3001` as soon as the build finishes (reload the
tab; open terminals drop with a restart). A failed build keeps the
running server on the last good one, and the in-memory login rate limit
clears on every restart, so neither ever bites while iterating.

Quality commands, host or container alike:

```sh
npm run lint           # ESLint (eslint.config.mjs) — lint:fix = --fix
npm run format:check   # Prettier (.prettierrc) — format = --write
```

**On the host** (no docker): `npm run dev:server` alone serves the same
`:3001` (build + boot + rebuild/restart on change) — you lose only the
containers around it. Uploads need the dev object store (without it,
`POST /api/files` answers 503):

```sh
docker compose --profile dev up -d dev-seaweedfs
WEB_PI_S3_ENDPOINT=http://127.0.0.1:8333 WEB_PI_S3_ACCESS_KEY=webpi-dev \
  WEB_PI_S3_SECRET_KEY=webpi-dev-secret npm run dev:server
```

The editor tab likewise needs an editor reachable from the host — run
the image with a published port, the workspace tree bind-mounted **at
the same path** (the tab opens the workspace cwd verbatim as the
editor's `?folder=`, and the editor opens it in its own container), and
a writable `$HOME`:

```sh
docker build -t web-pi-editor:local editor/
mkdir -p /tmp/webpi-editor-home && chmod 777 /tmp/webpi-editor-home
docker run -d --name webpi-editor-dev -p 127.0.0.1:13000:3000 \
  -u 2000:2001 -e WEB_PI_BASE=/ \
  -v "$PWD":$PWD -v /tmp/webpi-editor-home:/home/workspace \
  web-pi-editor:local
WEB_PI_EDITOR_UPSTREAM=http://127.0.0.1:13000 npm run dev:server
```

(`-v "$PWD":$PWD` — or whatever tree your workspaces' cwds live under:
the editor container must see each cwd at its own path. The compose dev
profile needs none of this — `dev-editor` is wired in by default.)

## Configuration (environment)

Everything is env-configured; defaults suit a single-user Linux box
running terminals (and pi, by hand) as the same user as the server.
The `WEB_PI_*` contract is declared
once, typed, in a schema shared by Astro and the Node server:
`astro.config.mjs`'s `env.schema` (imported from `src/lib/env-schema.ts`)
declares every runtime variable — names, types, and the static defaults —
and the compiled server reads the same schema through `src/lib/env.ts` (the
typed runtime equivalent of `astro:env/server` for a plain-tsc build; see
the comments there for why the server can't import the Astro virtual module
directly). Number variables that aren't integers stop the server at boot.
Defaults that must be computed at boot (homedir, app-root paths, the
login-shell command default, the vendored-pi path) live beside the reads in
`src/lib/env.ts`. The one
exception is the dev-only `WEB_PI_DEV_API`, which `astro.config.mjs` reads
directly.

| Variable | Default | Meaning |
|---|---|---|
| `WEB_PI_HOST` | `127.0.0.1` | Listen address (loopback + reverse proxy is the intended shape) |
| `WEB_PI_PORT` | `3000` | Listen port |
| `WEB_PI_TRUST_PROXY` | `0` | Reverse-proxy hops in front of the server (nginx = `1`, ALB → nginx = `2`; add one per proxy stacked ahead of it). The login/WS rate limits key on the client IP that many entries from the right of `X-Forwarded-For`; the origin check also derives its scheme from the `X-Forwarded-Proto` hop it selects (see [Security model](#security-model)); `0` ignores the headers and uses the socket peer. Set it to match your proxies: too low and every client shares the proxy's bucket, too high and clients can pick their own |
| `WEB_PI_BASE` | `/` | URL base path for path-mounting on a dedicated vhost (the app wants its own hostname — [Security model](#security-model)); the files that must agree are listed in [The base path](#the-base-path). **Baked into the pages at build time** — set it before `npm run build` *and* at runtime |
| `WEB_PI_HOME` | `os.homedir()` | `HOME` for spawned processes (tmux, the terminals' shells) |
| `WEB_PI_STATE_DIR` | `$WEB_PI_HOME/.local/state/web-pi` | one directory for all web-pi state: the sqlite db (`webpi.db`) and the runtime `pi-agent/` (pi credentials + its own sessions). Per-path overrides (`WEB_PI_DB_FILE`, `WEB_PI_AGENT_DIR`) still win. In the container compose points it at `/state` on a dedicated volume |
| `WEB_PI_AGENT_DIR` | `<state dir>/pi-agent` | runtime pi agent dir (config, credentials, pi's own session store) — seeded from the repo's `pi/` template where absent (a stray `PI_CODING_AGENT_DIR` in the server's env is ignored with an error logged). Every spawned terminal carries it as `PI_CODING_AGENT_DIR`, so a pi you run by hand stays on it |
| `WEB_PI_NEW_SESSION_CWD` | `$WEB_PI_HOME` | default cwd for new workspaces — the fallback when the parent app has no `cwd` of its own (shown as the start-path hint in the new-workspace dialog). The workspace root's `AGENTS.md` (the root agent's standing jobs instructions) is seeded into it where absent — [jobs](#scheduled-jobs-jobs-the-in-process-scheduler), [`root-agents/`](root-agents/) |
| `WEB_PI_COMMAND` | `$SHELL -l` (fallback `/bin/sh -l`) | the command a new terminal tab runs (whitespace-split) |
| `WEB_PI_JOB_LOG_DIR` | `/workspace/.webpi/job-logs` | root under which job runs persist their logs + exit files (`<dir>/<job>/<fired-at>.{log,exit}`) — a path that exists in both containers of the compose split (laid out by `workspace-init`); point it somewhere writable in other split shapes |
| `WEB_PI_JOB_LOG_MAX` | `20971520` (20 MiB) | write-time cap on each job run's log — past it the run wrapper's appender stops writing (one `[truncated at N bytes]` marker line) but keeps draining the job's output, so a chatty or runaway job can neither fill the disk mid-run nor die of a broken pipe. A non-integer or negative value stops the server at boot |
| `WEB_PI_SOCK` | `/run/web-pi/webpi.sock` when `/run/web-pi` exists (the compose split), else `<state dir>/webpi.sock` | the [internal jobs API](#scheduled-jobs-jobs-the-in-process-scheduler)'s unix socket: a second HTTP listener in the same server process serving the workspace side (agents) — see the jobs section. **Empty = the listener is off**; a set-but-non-absolute value stops the server at boot, like the S3 vars. The socket file is created `0660` — the file mode (the shared `webpi` group in the split shape) is the only auth |
| `WEB_PI_TMUX_SOCKET` | `web-pi` | the tmux socket the app uses. A relative *name* is the single-user shape: the app's own server, forked on the first session-creating call, under the per-uid default dir. An **absolute path** switches on the privilege split ([below](#the-privilege-split-two-containers)): tmux runs as another uid/container on that shared socket (`-S` instead of `-L` — a relative name resolves per-uid and cannot be shared), and terminal spawns, job runs and attaches refuse to fork a server, erroring with "workspace tmux server not running" instead. The server lifecycle is then the workspace side's job (`docker-workspace-entrypoint.sh`, or the host-install equivalent below) |
| `WEB_PI_TMUX_CONF` | `<app root>/tmux.conf` | tmux server config, applied when the tmux server starts (escape-time, scrollback, truecolour — see the file) |
| `WEB_PI_DB_FILE` | `<state dir>/webpi.db` | sqlite state db (0600): login credential, login sessions (`auth_sessions`), the workspace tree (`apps`, `workspaces`, `terminals`), scheduled-job tables (`jobs`, `job_runs` — the in-process scheduler + run logs), `settings` kv (the pi auto-update toggle + outcomes). Fresh setup: `npm run set-password` creates it |
| `WEB_PI_CLIENT_DIR` | `<app root>/dist/client` | Astro hashed assets |
| `WEB_PI_ASTRO_ENTRY` | `<app root>/dist/server/entry.mjs` | Astro SSR handler |
| `WEB_PI_S3_ENDPOINT` | *(unset: no storage)* | S3 API URL of the object store (`http://seaweedfs:8333` in compose). Unset, `POST /api/files` answers 503. Set, it needs both keys below — a half-set or non-http value stops the server at boot |
| `WEB_PI_S3_ACCESS_KEY` / `WEB_PI_S3_SECRET_KEY` | *(unset)* | the store's credentials. In compose, generated once by `seaweedfs-init` and loaded by the entrypoint — not set in `compose.yaml` |
| `WEB_PI_S3_BUCKET` | `webpi` | bucket for uploads (created on first use when missing) |
| `WEB_PI_S3_REGION` | `us-east-1` | SigV4 signing region — self-hosted servers accept any |
| `WEB_PI_EDITOR_UPSTREAM` | *(unset: editor off)* | the [VSCodium reh-web editor](docs/editor-webapp.md)'s upstream — the single switch: unset, `/editor/*` answers 404 and the console hides its editor tab; a malformed value stops the server at boot, like the S3 vars. Compose wires it by default (`http://editor:3000` — the editor container ships in the plain stack; set it empty in `.env` to switch the editor off). Auth is the web session itself — no token, no launcher URL; folders are URL params |
| `WEB_PI_DEV_API` | `http://127.0.0.1:3001` | dev only: where `astro dev` proxies `/api`, `/partials`, `/editor`, `/ws`, login/logout (the `npm run dev:server` process) |
| `WEB_PI_LOKI_URL` | *(unset: console-only)* | push URL of a Grafana Loki for the server's operational logs (`http://loki:3100` when the compose `observability` profile runs). Unset — the default, and the dev profile and plain hosts — logging is console-only, identical to before observability existed. A set-but-malformed value stops the server at boot, like the S3 vars |
| `WEB_PI_LOKI_JOB` | `webpi` | the `job` label every pushed log line carries — identifies this deployment in Loki's stream selectors. Letters, digits, `_`, `-`, max 64 chars |

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
  `-f` conf, cwd and `PI_CODING_AGENT_DIR` env a terminal tab
  gets). Runs are tmux sessions like any other — a **live** run is
  attachable from its card (`/?run=webpi-<name>`, the console's run
  attach mode), including runs that fired while you had no browser open.
- **Run logs**: the fire wraps the command so the run's output is
  appended to a durable log and its exit code captured to a file under
  `WEB_PI_JOB_LOG_DIR` (the log dir is created by the wrapper itself — a
  failed log write never kills the run). Each log is capped at write
  time (`WEB_PI_JOB_LOG_MAX`, 20 MiB by default): past the cap the
  wrapper's appender stops writing — one `[truncated at N bytes]`
  marker — while still draining the job's output, so a runaway job
  neither fills the disk mid-run nor dies of a SIGPIPE. The tick's
  finish observation reads the exit file back into `job_runs` (exit code + finish time;
  `unknown` when the file is missing), and the page shows each job's run
  history (fired-at, origin, duration, exit) with a log-tail viewer
  (`GET /api/jobs/:name/runs`, `GET /api/jobs/:name/runs/:fired_at/log`,
  the newest 1 MiB, text/plain). History is capped at 20 runs per job —
  pruning unlinks the pruned runs' log files before deleting their rows.
- **The job page (`/jobs/:name`)** — the job's definition with its edit
  entry, its run history (fired-at, origin, duration, exit), the
  log-tail viewer and the live-run link. It updates **live**: the
  service layer emits domain events at its mutation/observation choke
  points (`job_created` … `run_finished`) and the cookie-gated
  `/ws/events` WebSocket forwards them, so the jobs pages run the same
  partial refresh the moment anything changes a job — whoever changed
  it (the page, the CLI, the MCP tools, the scheduler's tick): one
  source of truth, evented. The 15 s poll stays as the safety net; the
  WS reconnects with backoff like the terminal's. Agents read job state
  through the CLI/MCP, never by scraping the page.
- **App tag**: a job is global, optionally tagged with an app
  (`app_id` — the picker on the save dialog, the chip on the card);
  never owned by one — deleting the app just un-tags its jobs.
- **Downtime catch-up**: each fire is recorded in `job_runs`; on boot the
  scheduler compares the last fire against the schedule and fires **one**
  catch-up run per job whose window passed while the server was down —
  systemd's `Persistent=true` equivalent, deliberately capped at one run
  (a job that missed three dailies runs once, not three times).
- **Run semantics**: a fire is **skipped** while the previous run's tmux
  session is still alive — long-running agent jobs don't pile up. "Run
  now" checks and returns 409 in that case. Deleting a job removes its
  definition, run history and log files but deliberately leaves a live run's
  session alone.
- **Internal API (agents)**: the workspace side gets the same jobs
  surface over a second HTTP listener on a unix socket (`WEB_PI_SOCK`,
  above) — JSON only, verbs mirroring the cookie-gated `/api/jobs`
  family (`GET`/`POST /jobs`, `POST /jobs/validate`, `PATCH`/`DELETE
  /jobs/:name`, `GET /jobs/:name/runs`, `POST /jobs/:name/run`, `POST
  /jobs/:name/runs/:firedAt/kill`, `GET /jobs/:name/runs/:firedAt/log`,
  plus `GET /apps` for the job-tag picker) and answering the same
  Result JSON. Every verb calls the same `src/lib/jobs` service
  functions the browser routes do — one source of
  truth. No cookie/CSRF/rate-limit layer applies: the socket file's
  `0660` mode is the gate (full jobs control is the workspace side's own
  shell privilege — zero escalation), and nginx/the TLS proxy never see
  the listener. A stale socket file is removed at boot; a socket a
  LIVE server answers on — two servers sharing one state dir, a real
  dev/test shape — no longer stops the boot (§3 amended in
  integration): the instance serves on with the listener off and a
  loud boot line telling you to stop the other server or point
  `WEB_PI_SOCK` elsewhere. Design:
  [docs/jobs-agent-plan.md](docs/jobs-agent-plan.md)
  §3–§4.
- **The `webpi` CLI (agents, and humans in a terminal)**: a third bin
  (`package.json`, shipped in both containers of the split — the
  workspace side is its whole point) over that socket, parity with
  every action the /jobs page offers: `webpi jobs list [-a <app>]`,
  `runs <name>`, `log <name> <firedAt>`, `create`, `set`, `delete`,
  `run`, `kill`, `validate`. `--help` is the agent-facing documentation
  — self-describing, no discovery round-trip — and `--json` prints the
  server's raw answer for scripting. Exit codes: 0 success, 1 the
  operation failed (the server's error answer, or no server on the
  socket), 2 usage; `validate`'s ANSWER is the validity, so 1 =
  something invalid. The socket is discovered `$WEB_PI_SOCK` →
  `/run/web-pi/webpi.sock` → `<state dir>/webpi.sock`, a friendly error
  naming the knob when off. Design:
  [docs/jobs-agent-plan.md](docs/jobs-agent-plan.md) §5.
- **MCP over the internal API (agents, in-session)**: `server/mcp.ts` is
  a stdio MCP server — also runnable as `webpi mcp`, the dev-shape
  convenience — whose tools are 1:1 with those verbs (plus `apps_list`)
  — registered for every pi session by the [`pi/`](pi/) template's
  `mcp.json` (see its README for the exposure, the absolute `/opt/web-pi`
  path it spawns, and the dev-shape difference). Tool results carry the
  internal API's Result JSON verbatim — an agent reads the same answers
  the console and the CLI do. Design:
  [docs/jobs-agent-plan.md](docs/jobs-agent-plan.md) §6.
- **Root-agent conventions (`AGENTS.md`)**: the workspace root's
  `AGENTS.md` — the root agent's standing instructions: scheduled work
  belongs in jobs, a fired run is *started, not finished* (poll the run
  history and check exit codes), and the tool surface above — is
  seeded only-where-absent (the pi-template policy) from the repo's
  [`root-agents/`](root-agents/) template into the default workspace
  cwd (`/workspace` in the split): by the workspace entrypoint (uid
  2000) there, by the server boot next to the pi-template seeding in
  single-user shapes. App agents in checkouts under the root read it by
  upward walk — accepted same-uid usage. Design:
  [docs/jobs-agent-plan.md](docs/jobs-agent-plan.md) §9.
- The trade-off vs the old systemd timers: nothing fires while web-pi
  itself is down (hence the catch-up above). Job commands run as the
  web-pi user, on the app's socket, per the security model — the terminal
  is the product.

## Pi: dependency & config isolation

pi is a versioned dependency (`@earendil-works/pi-coding-agent` in
`package.json`; the vendored binary's version is logged at boot when it
is the configured command), not something installed on the box. Its
config is project-controlled too:

- [`pi/`](pi/) in the repo is the **template** — settings, `mcp.json`,
  skills, extensions; whatever the install should ship to every terminal.
- The **runtime agent dir** (default `<state dir>/pi-agent`) is
  seeded from it **only where absent**: existing files always
  win, so settings pi itself writes and operator edits are never clobbered,
  while template files added by upgrades still land. State only pi writes
  (`auth.json`, `sessions/`) is never in the template. The seeder is
  whoever owns the dir: the server at boot in single-user shapes, the
  workspace entrypoint in the split (so every file lands uid-2000-owned).
- A sibling one-file template, [`root-agents/AGENTS.md`](root-agents/),
  seeds the **workspace root's** `AGENTS.md` — the root agent's standing
  jobs instructions — with the same only-where-absent policy and the
  same seeder halves, but into the default workspace cwd
  (`WEB_PI_NEW_SESSION_CWD`), not the agent dir: app checkouts under
  the root read it by upward walk (see the jobs section).
- Every spawned terminal carries `PI_CODING_AGENT_DIR=<runtime dir>`
  (delivered via `tmux new-session -e`, deterministic per session) — a pi
  you run by hand in one never touches your `~/.pi/agent`, in either
  direction.

Consequences: a pi you run in a terminal doesn't see credentials already
in your global pi config — `/login` once inside it (or seed the runtime
`auth.json`).

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
docker compose up -d        # web + workspace + editor + seaweedfs + one-shot inits; loopback :3000, TLS reverse proxy in front
docker compose --profile observability up -d   # additionally: loki + grafana (Observability below) — set WEB_PI_LOKI_URL too
docker compose exec webpi node dist-server/server/set-password.js   # once, on a fresh deploy
```

(`npm start` is the middle two lines in one.) The editor container is
part of the plain stack and its proxy is wired on by default — set
`WEB_PI_EDITOR_UPSTREAM` empty in `.env` if you'd rather run without it
([The editor](#the-editor-vscodium-reh-web) below).

### The privilege split (two containers)

`docker compose up` boots three services from one image (prod shape of
[DESIGN_REVIEW.md](DESIGN_REVIEW.md) §1.1):

- **webpi** (uid `node`, the image's user) — serves the HTTP/WS app from
  the image's copy at `/opt/web-pi`, which is **root-owned**: a prompt
  injection inside a terminal can no longer rewrite the server, replace
  the login credential, or plant persistence in it. Owns web state
  (`webpi.db`) on the `webpi-state` volume at `/state`. Never runs the
  tmux server — it is only a client on the shared socket.
- **workspace** (uid 2000, user `workspace`) — owns the tmux server and
  every terminal and job-run session. Its entrypoint
  (`docker-workspace-entrypoint.sh`)
  starts the tmux server on the shared absolute-path socket
  `/run/web-pi/tmux` with `exit-empty off` (so it survives between
  sessions — web's never-fork guard depends on it), `chmod 0660` +
  `chgrp webpi` on the socket (tmux creates it 0600 regardless of umask),
  admits the web user with `tmux server-access -a node`, seeds the runtime
  pi-agent from the image's `pi/` template and the workspace root's
  `AGENTS.md` from its `root-agents/` one (only where absent — same
  policy as the single-user server boot), and supervises the server.
  Workspaces' files live on the `webpi-workspace` volume at `/workspace`
  (the default workspace cwd — `WEB_PI_NEW_SESSION_CWD` prefills the
  dialog); pi's runtime dir (`WEB_PI_AGENT_DIR=/workspace/pi-agent`,
  credentials + pi's own session store) is there too.
- **workspace-init** (one-shot, root) — `chown workspace:webpi` +
  `chmod 2770` on the socket dir (`webpi-tmux` volume at `/run/web-pi`),
  `/workspace`, and the job-run log dir `/workspace/.webpi/job-logs`
  (its own `webpi-job-logs` volume): empty named volumes start root-owned,
  and the socket dir must be setgid group `webpi` (gid 2001) for the
  sharing below.

The two halves share a `webpi` group (gid 2001; `node` is a member, it is
`workspace`'s primary group). The workspace side runs with **umask 0007**,
which the tmux server passes on to everything it spawns: everything a
terminal or job run writes lands group `webpi` and group-readable, which
is what lets the web uid read and prune the job-run logs (web mounts
`/workspace` itself read-only; the log dir is a separate read-write volume
mounted at the same path — see below). Cross-uid tmux access is
what `server-access` grants: without an entry the foreign-uid client gets
a hard "access not allowed"; with it, full client access on the socket.

Path agreement matters in this shape: `WEB_PI_COMMAND`'s default (a login
shell — `$SHELL` must exist in the workspace container, where the tmux
server actually spawns it) and the workspace cwd resolve **in the
workspace container** — both containers use the same image and mount the
shared volumes at the same paths, so the defaults hold (a `WEB_PI_COMMAND`
pointing at the image's vendored `/opt/web-pi/node_modules/.bin/pi` is
the classic case). Scheduled jobs are unchanged: the scheduler fires
runs on the same shared socket (same guard, same env), so they land in
the workspace container too, their logs on the shared `webpi-job-logs`
volume — a job only runs while the web server is up, exactly as before.

The pre-split `webpi-app` volume (the entrypoint-synced `/app` the server
served from) is obsolete — web serves from the image now — and is left in
place, unused, on existing hosts.

### The editor (VSCodium reh-web)

The Zed/KasmVNC webapp is gone (streaming a desktop GUI was the poor fit:
separate basic auth, one instance, no per-folder URLs, a launcher
container — see [docs/editor-webapp.md](docs/editor-webapp.md) for the
full story of what replaced it). The editor is VSCodium's **reh-web**
build — self-hosted VS Code in the browser with server-side files —
served through web-pi's own **same-origin `/editor` proxy** behind the
session gate, never published directly. It ships in the plain compose
stack: `up -d` starts it and wires the proxy on
(`WEB_PI_EDITOR_UPSTREAM` defaults to `http://editor:3000`); set that
variable empty in `.env` to run without it — `/editor/*` then answers
404 and the console hides its editor tab. Two services from a thin
in-repo image (`editor/`, the pinned reh-web tarball):

- **editor** (uid 2000) — `codium-server` on the compose network (publishes
  nothing), `--server-base-path ${WEB_PI_BASE%/}/editor` so its asset URLs
  line up with the proxy. Edits the same `webpi-workspace` volume at the
  same `/workspace` path as the workspace container; VSCodium's
  user-data/extensions live on the persistent `webpi-editor-home` volume
  at `/home/workspace`.
- **editor-init** (one-shot, root) — chowns that home volume: empty named
  volumes start root-owned, and uid 2000 must write `$HOME`.

Auth is the web session itself — same origin, no cross-origin cookies,
no prompts; every editor tab is an iframe of
`${BASE}/editor/?folder=<workspace cwd>` (one editor server, many
folders). Its integrated terminal is another web shell as the same uid
2000 the terminals give you, behind the same session gate: logout /
"log out everywhere" cut its sockets with the terminals. It never
touches the tmux socket or web state.

### Object storage (SeaweedFS)

Uploads (`POST /api/files`) go to an S3 bucket through the AWS SDK
(`src/lib/storage.ts`). Nothing in the app is specific to one server; the
compose stack runs [SeaweedFS](https://github.com/seaweedfs/seaweedfs)
(`weed mini`, pinned) — MinIO's community edition was archived in 2026
and its images are gone. Two more services:

- **seaweedfs** — S3 API on `seaweedfs:8333`, data on the `webpi-seaweedfs`
  volume. It sits on the `storage` network (`internal`: no route out)
  with **webpi only**: the workspace container, where the terminals run,
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
services.

Uploads stream end to end: the multipart body is parsed as it arrives
(`streamFileUpload`, busboy) and piped into an S3 multipart upload, so the
server holds a few MiB per upload whatever the size (~65 MiB of buffers at
peak, measured on 512 MiB–1 GiB files). The policy is
`src/schemas/uploads.ts`: 5 GiB, and a small set of types that are inert
if ever rendered. Keys are `uploads/<uuid>`, stored with the client's file
name as an `attachment` Content-Disposition. Downloads
(`GET /api/files/<key>`) stream back from the bucket and are always
attachments, sandboxed by their own CSP; a stored type outside the
allowlist is served as `application/octet-stream`. They resume: a single
byte range (`Range`) is passed through to S3 — 206 with `Content-Range`,
416 with the size past the end; multiple ranges are ignored (the whole
file). `If-Range` is honoured (S3 has none, so storage compares it with
the object's ETag / Last-Modified and sends the whole file if it changed),
and `HEAD` answers the headers from S3's HeadObject without opening the
body.

Two limits besides the app's own, for big files:

- **nginx** — `deploy/nginx-webpi.conf` allows the 5 GiB body
  (`client_max_body_size`) and streams bodies through
  (`proxy_request_buffering off`) instead of spooling each to disk first.
  A proxy left at nginx's 1 MiB default refuses uploads with its own 413.
- **Request deadlines** — Node's 5-minute whole-request timeout is
  replaced in `server/main.ts`: every request must still arrive within
  5 minutes, except a signed-in upload, which may take as long as it
  needs but is dropped after 2 minutes without a byte.

### Observability (logs → Loki, dashboards → Grafana)

The server's operational logging goes through a winston logger
(`src/lib/logger.ts`) with **two transports**: a console transport,
always — pretty, human-readable lines (`<iso-time> <level> [component]
<message> {meta}`), because the boot log and `docker compose logs` are
read by humans — and a `winston-loki` push transport **only** when
`WEB_PI_LOKI_URL` is set. Unset (the default everywhere: plain host,
npm install, the dev profile, a compose `up` without the profile), the
logger is console-only and behaves exactly like the `console.*` calls it
replaced: no network, no retries, no startup delay. Set but unreachable,
Loki degrades silently — lines batch for 5 s, a failed batch is dropped
(bounded memory), the transport retries on its built-in 60 s backoff and
warns on the console at most once per 10 minutes; the server never
crashes on it (unit-tested with a dead URL: no unhandled rejections).
SIGTERM drains it: the shutdown sequence's last step flushes Loki's
final batch, capped well inside the stop deadline.

What is logged, and at which level (`winston`'s npm set):

- `info` — lifecycle: the boot summary, terminal sessions
  opened/respawned/killed,
  a terminal attached/detached, login/logout (`username` is logged — single-user
  app; credentials, tokens and cookie values never are), scheduler job
  fires and run finishes (observed at the scheduler's ~30 s tick — a
  run's end is reported by the first tick after it; only one that ends
  before any tick could see it, e.g. while the server is down, is only
  counted as fired), pi updates (manual and auto), uploads stored.
- `warn` — degraded operation: failed logins at the rate limit, the
  scrypt 503, ws upgrade rejections, job schedules that no longer parse,
  failed uploads.
- `error` — db failures behind auth/session reads, scheduler tick
  failures, spawn/crash guards, shutdown drain failures.
- `http` — a one-line access log at the node-server level (`method path
  status in Nms`).
- `debug` — what would bury an open console: the 15 s `/api/state` poll
  every open tab runs, WS connects (one line per socket open — every tab
  load and reconnect, before any attach succeeds), and hashed-asset/PWA
  hits. Console-silent (the console transport sits at `http`), pushed to
  Loki (which sits at `debug`), where volume is cheap.

In Loki, each line carries exactly three stream labels — `job`
(`WEB_PI_LOKI_JOB`), `level`, `component` (`boot`, `http`, `auth`, `ws`,
`tmux`, `scheduler`, `update`, `storage`, `shutdown`) — and everything
else (paths, durations, session names) rides in the line's JSON, so
labels stay low-cardinality. A few log sites deliberately stay on
`console.*`, commented in place: `set-password` (a one-shot CLI prompting
a human) and the Astro-bundled code — `zod.service.ts` and the `.astro`
render guards (`settings.astro`, the `jobs-list` and `settings`
partials) — where winston must stay out of the Vite bundle. Those
guard lines reach the console only, never Loki.

Bring the stack up (opt-in `observability` compose profile — a plain
`up` starts none of it, and nothing breaks when Loki is absent):

```sh
WEB_PI_LOKI_URL=http://loki:3100 docker compose --profile observability up -d
```

That env var (via compose interpolation) is what points the webpi
service at Loki over the compose network — `up -d` recreates webpi to
pick it up. **Grafana** is loopback-published on `127.0.0.1:3300`
(3000/3001 are web-pi's own): browse to it, the Loki datasource is
already provisioned (`deploy/grafana/provisioning/`), anonymous access
is read-only (Viewer) — enough to query logs — and the `admin` account
(its default password must be changed on first login) is for editing.
Grafana keeps no state volume: dashboards worth keeping belong in
`deploy/grafana/provisioning/dashboards/` as files. **Loki** publishes
no port at all — only the webpi and grafana containers reach it — stores
on the `webpi-loki` volume, keeps **14 days** (compactor retention),
rejects oversized/too-old entries and overlong labels
(`deploy/loki/config.yaml`), and phones nothing home. First queries:

```
{job="webpi"}                     # everything
{job="webpi", component="http"}   # the access log
{job="webpi"} |= "login failed"   # auth failures
```

A non-compose install points `WEB_PI_LOKI_URL` at any reachable Loki
the same way. Killing Loki (`docker compose stop loki`) must change
nothing about the server: one warn line per 10 min in its logs, requests
and sessions unaffected; the access log and every event line return on
its next `up`.

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
user read and prune the job-run logs; `exit-empty off` must ride the
server-start conf,
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
pi-agent template — or the workspace root's `AGENTS.md` — in this shape:
the single-user server-boot seeding is off with an absolute socket, so
copy the repo's `pi/` into the runtime agent dir and its `root-agents/
AGENTS.md` to the workspace cwd yourself, as `web-pi-work`, if you want
the shipped defaults.)
And run the server itself, as your user, with the split env —
`WEB_PI_TMUX_SOCKET=/run/web-pi/tmux`, a workspace cwd
(`WEB_PI_NEW_SESSION_CWD`), a `WEB_PI_JOB_LOG_DIR` and
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
webpi jobs list                 # the third bin: the jobs CLI (see the jobs section)
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
  the nginx access log for failed logins (401/429 on the login POST)

State is split by owner, like everything else in the two-container shape:
`webpi.db` (login credential, login sessions, the workspace tree, jobs) lives
on the `webpi-state` volume at `/state` (`WEB_PI_STATE_DIR`), owned by the web
uid; `pi-agent/` (pi credentials + pi's own session store) lives on
webpi-workspace
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
honest limit of "terminals survive restarts": the tabs and structure
always survive (rows in the state db) and a dead tab respawns fresh at
the workspace cwd on its next attach — tmux surviving (a web restart,
the common case) means content survives; tmux dying means structure
survives and content starts over. Job runs die with their sessions, but
their logs + exit codes outlive them on the `webpi-job-logs` volume. If
the workspace container is merely slow to boot (or the socket is
missing), terminal spawns report "workspace tmux server not running"
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
  — the POST path inside `failregex` (the login POST), likewise the
  file's only occurrence; the NOTE above it points here and at the nginx
  capture.

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

- **Split containers (the compose default):** terminals run the image's
  vendored pi when you run `pi` by hand, so updating pi is updating the
  image: `npm install
  @earendil-works/pi-coding-agent@latest` in your checkout, `docker
  compose build && docker compose up -d`. The workspace container picks
  the new binary up on the next `up` (pi is exec'd when you run it;
  terminals already running it finish on the old one). Durable in-place
  updates without a rebuild: install pi standalone on the workspace
  volume and point `WEB_PI_COMMAND` at it (every new terminal tab then
  runs it) — pi's own dependency tree is pure JS (verified:
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
  the resulting version. No restart is needed: pi is exec'd when you run
  it; terminals already running it finish on the old one. Concurrent updates are refused;
  npm missing from the server's PATH is reported instead of
  installed-around. (In the **docker dev profile** `node_modules` is a
  shadow volume and `npm install` re-runs from the lockfile on every
  boot, so an update made in place does not persist there.)

Stay within the `^1` range web-pi declares (pi stays a vendored
dependency — run by hand in terminals, updated from `/settings` — and the
update actions stay inside that range).

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
shapes** (host install, npm global) it is the install dir your terminals
run pi from, and auto-update moves them as described above. In the **split
containers** (the compose default) the server runs from the web
container's `/opt/web-pi` — not the workspace side your terminals run pi
from — so an auto-update there only moves the copy `/settings` reports,
and it survives only until the next image deploy; use the image or
standalone-workspace flows above to change what your terminals actually
run.
Sending the auto-update install to the workspace side is a marked junction
in `src/lib/auto-update.ts` for a later pass. In the **docker dev
profile** `node_modules` is a shadow volume and `npm install` re-runs
from the lockfile on every boot, so nothing auto-updated persists there.

**App code:** rebuild + `up -d` — the web container serves the image's
`/opt/web-pi` copy, so an image rebuild IS the deploy; nothing syncs a
running copy anymore. Volumes (`webpi-state`, `webpi-workspace`) never
re-seed when image content changes.

**Git-owned checkout:** the image copy is root-owned by design — a
terminal can't edit it, and nothing inside a container (human or agent)
can change what the web container serves: the webapp is an appliance,
redeployed the normal way (edit on the host → build the image → `docker
compose up -d`). A git checkout on the workspace volume is still where
you (or an agent) keep projects — including a checkout of web-pi itself
for reading or forking — but it no longer feeds any build-and-swap flow;
if you want terminals to run pi from such a checkout, use the
standalone-workspace install above (`WEB_PI_COMMAND`).

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
  never owns the tmux server; terminals run as uid 2000 in the workspace
  container (the editor, same uid, in the opt-in `editor` profile — its
  integrated terminal is another web shell behind the same session gate)
  and cannot reach the server's state at all — web's `/workspace` mount
  is a read-only view, not a bridge in the other direction (its only
  read-write piece there is the job-log volume at the same path), and
  the login db on `/state` is mounted only on the web container. Host
  installs get the same guarantee from the two-user setup below; a
  single-user install (npm global, dev profile, `WEB_PI_TMUX_SOCKET`
  left relative) keeps the simpler one-uid shape and its one-uid blast
  radius.
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
  `POST /api/files` (5 GiB + multipart envelope). `server/main.ts`
  refuses an oversized `Content-Length` (413) — and a length-less
  chunked body (411) off the upload route — before Astro reads a byte;
  the adapter's `bodySizeLimit` (the upload cap) backstops a stream.
  Every body must arrive within 5 minutes (slow-drip bodies are cut off,
  signed in or not, even after an early 401); only a signed-in upload
  trades that for a 2-minute stall timeout.
- Object storage is reachable only from the web container (compose's
  internal `storage` network), with generated credentials; uploads are
  stored as `attachment`s and limited to types that are inert if ever
  served back (no HTML, no SVG).
- Job log tails read only the last 1 MiB of a run's log file (text/plain,
  never rendered as HTML), and log paths are built server-side from the
  run's own row — never from client input.

## Project shape

- `src/pages`, `src/layouts` — Astro pages (login + app shell), SSR'd
- `src/layouts/Base.astro` — Web Awesome default theme + global styles
  (astro-lit hydration support is imported by each component script —
  import order vs wa-* modules matters, see AGENTS.md)
- `src/components` — web components: `<console-app>` (the orchestrator),
  `<workspace-sidebar>` (the app switcher), `<terminal-tabs>`,
  `<agent-terminal>` (xterm.js island); each static shell is SSR'd by an
  Astro wrapper (`ConsoleApp.astro`, `AgentTerminal.astro`)
- `src/lib` — shared strict TS: auth (scrypt + persisted sessions + rate
  limiter), tmux helpers, the apps/workspaces domains (the workspace tree,
  terminal lifecycle, `apps.ts`/`workspaces.ts`), the editor proxy
  (`editor.ts`), scheduled jobs (in-process scheduler, persisted run logs),
  operational logging (`logger.ts`: winston —
  console always, a Loki push transport when configured), wire types,
  typed env schema + reads
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
  assets, the Astro SSR handler (pages + API), WS → node-pty → tmux, the
  same-origin `/editor` reverse proxy (HTTP streaming + raw WS
  tunnels, per-token tracking — `src/lib/editor.ts`), the internal jobs
  API on its unix socket (`internal-api.ts` — same Result JSON as the
  browser routes) and the stdio jobs MCP server (`mcp.ts`)
- `src/pages/jobs.astro` + `src/components/JobsApp/` — the scheduled-jobs
  page (list/create/edit/run/delete, cron validation, app tag, run
  history + log viewer), plus the per-job detail page
  `src/pages/jobs/[name].astro` — live-updated over `/ws/events`
  (`src/lib/events.ts` — the domain-event bus)
- `pi/` — the controlled pi agent-dir template (settings, MCPs, skills,
  extensions) seeded into the runtime dir; `root-agents/` — the one-file
  workspace-root `AGENTS.md` template (the root agent's jobs
  conventions), seeded by the same boot halves; `cli/` — the `webpi`
  bin: the jobs verbs + `webpi mcp`, a zero-runtime-dep client over the
  internal socket; `tmux.conf` at the root is the
  tmux server config — together they're the shipped "environment config"
- `editor/` — the VSCodium reh-web editor image (pinned tarball, uid 2000)
  for the compose `editor` profile — `Dockerfile` + entrypoint
  ([docs/editor-webapp.md](docs/editor-webapp.md))
- `Dockerfile`, `docker-entrypoint.sh`, `docker-workspace-entrypoint.sh`,
  `compose.yaml` — one image, two prod roles (web: serves root-owned
  `/opt/web-pi`; workspace: uid 2000, owns tmux + the terminals) + the
  slim prod default and toolchain dev targets
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
