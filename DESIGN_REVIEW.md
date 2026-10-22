# web-pi — design & deployment review

*Review date: 2026-10-04, against `main` at 0cefbad plus the fixes made
alongside this report (listed at the end). Scope: architecture and
deployment shape on a single VPS (nginx + Docker, or a host install) and on
AWS ECS/Fargate behind an ALB. Line-level bugs and small items are tracked
separately.*

**Bottom line:** web-pi is a good single-user, single-host tool, and that
is the shape it should commit to. The decisions worth making now, before
apps are built on top:

1. Stop running the agent with write access to the server and its
   credential.
2. Lock the browser side down so that a script on a neighbouring site
   can't reach the terminal.
3. Pick one deployment target to optimise for. ECS works only with caveats
   that undercut most of what it's normally for.

## 1. Everywhere

### 1.1 The agent is a threat actor, not just the cookie holder

The README's security model is "anyone with the session cookie can type
into a shell". That's true but incomplete. pi reads untrusted input (repos,
web pages, MCP tool output, issue text), and a prompt injection runs
commands as pi. pi runs as **the same uid as the web server**, so it can:

- rewrite the server itself: in Docker, `/app` (including
  `dist-server/server/main.js`) is owned by `node`, the uid sessions run
  as; on a host install it's the operator's checkout;
- read or replace `auth.json`. Mode `0400` only protects against *other*
  users, and the owner can `chmod` it;
- on a host install, add a `~/.config/systemd/user/webpi-*.timer` for
  persistence (the jobs page would even list it);
- read pi's own provider credentials in the runtime agent dir.

One injected instruction can therefore backdoor the login and survive
restarts. This also blocks a TODO item: a "panic endpoint that is protected
from modification" can't exist while the code being protected is writable
by the process it protects against.

**Recommendation:** split privileges between *serving* and *working*.

- **Minimum:** the server's code and `auth.json` are owned by a different
  uid from the one sessions run as, and are read-only to it. Sessions
  still get a writable workspace.
- **Container shape that achieves it:** two containers sharing a tmux
  socket directory.
  - **web:** uid A. Holds the code (immutable, from the image), auth and
    state. Runs the HTTP/WS server and only *attaches* to tmux.
  - **workspace:** uid B. Runs the tmux server and pi, with the project
    checkouts on a volume. tmux 3.3+ can admit another user's clients
    (`server-access`); check the version in the base image.
  - **Self-modification** (later note: retired outright, before it ever
    shipped — the webapp is an appliance, changed only by rebuilding the
    image on the host). The split's promise is now unconditional: web
    serves root-owned code and owns its state; the workspace uid owns
    everything it can touch. No "except the one page that swaps the
    server" carve-out.
- **Cheaper interim:** keep one container, but run the server from a
  root-owned, read-only copy instead of the `node`-owned `/app` volume.
  `/opt/web-pi` is already the image copy; drop the `--chown=node:node`
  from its `COPY` and start from there. That closes the "rewrite the
  server" path, though not the auth-file path.

### 1.2 Browser-side hardening

Today there is no Origin check on the WebSocket upgrade
(`server/main.ts:465`) or on the JSON POSTs, no Content-Security-Policy, and
no `frame-ancestors` / `X-Frame-Options`.

`SameSite=Strict` does most of the work against cross-*site* requests, but:

- **Sibling subdomains are same-site.** If web-pi is `console.example.com`
  and anything on `*.example.com` has an XSS hole, that page can open the
  terminal WebSocket with the user's cookie attached (cross-site WebSocket
  hijacking).
- **The README suggests a subpath of an existing site**
  (`WEB_PI_BASE=/console` "when riding an existing site"). That is the same
  *origin*: any XSS anywhere on that host can read the console's responses,
  and the cookie's `Path` is no barrier to same-origin scripts. On this
  app, XSS means a shell.

**Recommendation:**

1. Give web-pi its own hostname, and drop "riding an existing site" from
   the README.
2. Check `Origin` against the expected origin (one config value, or
   derived from `Host` + `X-Forwarded-Proto` behind a trusted proxy) on the
   WS upgrade and on every non-GET request. It's a few lines, and it's the
   standard defence against cross-site WebSocket hijacking.
3. Send a strict CSP (`default-src 'self'`; `script-src 'self'` plus
   hashes if Astro inlines any scripts; `connect-src 'self'` covers the
   same-origin `wss:` in current browsers; list the `wss://` origin
   explicitly for older Safari), `frame-ancestors 'none'`,
   `X-Content-Type-Options: nosniff`, and `Referrer-Policy: same-origin`.
   The client already renders every interpolation through `esc()`; CSP is
   the backstop for when one is missed.
4. Ship the Web Awesome icons with the app. They currently load from a
   CDN (see `offline.astro`'s comment and the TODO), which a strict CSP
   would block, and it leaks usage to a third party.

### 1.3 Session lifecycle

- **Logout doesn't end live terminals.** `POST /logout`
  (`server/main.ts:255`) drops the token, but WebSockets already
  authenticated with it stay open until closed. Logging out on another
  device (or after a suspected theft) leaves those terminals running.
  Track sockets per token and close them in `drop()`.
- **Two expiry clocks disagree.** The server extends a token's expiry on
  every request (`auth.ts:62`), with no absolute cap. The cookie's
  `Max-Age` is fixed at login (`auth.ts:70`) and never refreshed. So the
  browser forgets the cookie after 7 days regardless of use, while a
  *stolen* token stays valid indefinitely as long as it keeps being used.
  Pick one model: either an absolute lifetime (no sliding), or sliding plus
  a refreshed cookie plus an absolute cap.
- **"Log out everywhere" doesn't exist yet,** and is cheap: clear the token
  map and close all sockets.

### 1.4 Process model: a server exit is a session wipe in containers

`PI_DURABLE_REPORT.md` counted tmux as the thing that keeps pi alive
through a web-pi crash. That holds on a bare host only. In the container,
Node is the main process: when it exits, the container stops and the tmux
server goes with it. This pass removed the crash paths found (malformed WS
frames, malformed path escapes) and added catch-alls, but the property is
still "any unhandled error, OOM or deploy ends every session".

Also, the server installs **no SIGTERM handler**. Compose's `init: true`
keeps stops prompt, but nothing closes WebSockets or flushes state
deliberately on shutdown.

**Recommendation:**

- Add a SIGTERM/SIGINT handler: stop accepting connections, close sockets
  with a "server restarting" message (the client already reconnects), and
  exit.
- If sessions must survive server restarts in Docker, run tmux under a
  supervisor (s6-overlay, or the two-container split in 1.1) rather than as
  a child of the Node process tree.

### 1.5 What's fine and should stay

- Every subprocess is spawned with an argv array (never through a shell).
- Systemd unit names come from one validated allowlist.
- Auth fails closed until a credential exists.
- scrypt with `timingSafeEqual`.
- Containers are non-root, with `no-new-privileges`.
- Loopback bind by default.
- The e2e suite is hermetic. Keep those properties as features land.

## 2. ECS / Fargate

ECS can run web-pi, but almost everything ECS is usually chosen for
(rolling deploys, multiple tasks, replaceable tasks) works against it.

| Concern | What happens on ECS | Recommendation |
| --- | --- | --- |
| One instance only | Sessions, rate limits and tmux are in-process. Two tasks behind the ALB split cookies and WebSockets between them, giving random 401s and attaches to the wrong task. | `desiredCount: 1`, deployment `minimumHealthyPercent: 0` / `maximumPercent: 100`. Accept a short outage per deploy. |
| Every deploy kills all sessions | Task replacement (deploys, Fargate maintenance retirements, Spot) ends the tmux server. | Accept and document, or adopt the two-container split with tmux in a longer-lived service. |
| `init` only exists in compose | ECS ignores `init: true`, so Node becomes PID 1 and the kernel drops an unhandled SIGTERM. Stops wait out `stopTimeout`, then SIGKILL. | Set `linuxParameters.initProcessEnabled: true`, or better, bake `tini` into the image's `ENTRYPOINT`. Add the SIGTERM handler (1.4). |
| App code on a volume | The entrypoint `rm -rf`s and `cp -a`s every top-level entry, `node_modules` included, into `/app` on each image change (`docker-entrypoint.sh:43-44`). On EFS that is tens of thousands of small-file operations at milliseconds each. It can outlast the health-check grace period, and it isn't atomic. Two overlapping tasks race on it. On ephemeral storage, `auth.json` is lost with every task. | Run code from the image (`/opt/web-pi`). Put only state on EFS: auth, hidden sessions, `.pi-agent`, workspaces. |
| No way to set the first password without a shell | Auth fails closed until `set-password` runs, which on Fargate means ECS Exec into the task. | Accept a pre-hashed credential from the environment (`WEB_PI_AUTH_HASH`, injected from Secrets Manager) as an alternative to the file. |
| Sidebar poll blocks the event loop | `/api/state` stats every session file and synchronously reads up to 200 × 64 KiB (`sessions.ts:61`), per open tab, every 15 s. That measured about 40 ms on a local SSD with 638 files. On EFS, expect seconds per poll, during which no terminal traffic moves. | Cache titles keyed by `(path, mtime)`, and move the scan to async `fs.promises`. |
| ALB idle timeout | Default 60 s. **Fixed in this pass:** the server pings every 30 s, and the client reconnects after a drop. | Keep the ALB idle timeout above 30 s. |
| Client IP behind the ALB | ALB appends to `X-Forwarded-For`. **Fixed in this pass:** set `WEB_PI_TRUST_PROXY=1` (ALB direct) or `2` (ALB → nginx). | Set it in the task definition. |
| Scheduled jobs | No systemd in the container, so `/jobs` is permanently in degraded mode. | See 3.1. |
| Health check | `GET <base>/login` returns 200 unauthenticated and is cheap enough. | Use it for the target group. |

If the goal is "web-pi on AWS", a single EC2 instance with Docker (the VPS
shape below) gives persistent tmux, systemd and simple storage. Fargate
gives none of those.

## 3. VPS (nginx + Docker, or host install)

This is the shape the project is designed for, and it works well with the
fixes in this pass.

### 3.1 The recommended install loses `/jobs`

The README says "container-first" and that the systemd unit is gone. But
the jobs feature runs on `systemctl --user`, which only exists in a host
install. So the recommended deployment ships a feature that is always
switched off. Pick one:

- **Make the host install first-class again,** with a documented
  `web-pi.service` user unit, linger, and the same nginx/fail2ban setup.
  This is the best fit for jobs as designed, because timers fire even when
  web-pi is down.
- **Move scheduling in-process** (or `supercronic` in the container),
  keeping the run-inside-tmux behaviour. Jobs then work wherever the app
  runs, at the cost of "fires while the server is down". Systemd's
  `Persistent=true` catch-up is easy to emulate on boot.

### 3.2 Reverse proxy and fail2ban

- `deploy/nginx-webpi.conf` now documents `WEB_PI_TRUST_PROXY=1`, and
  compose sets it. On a host install behind nginx, set it yourself;
  otherwise every login shares nginx's address and one attacker can lock
  the owner out for 15 minutes.
- fail2ban (which bans on nginx's own `$remote_addr`) and the app limiter
  now complement each other. Before this pass the app limiter could be
  bypassed, and fail2ban was the only real control.
- The fail2ban filter hard-codes `/webpi/login`. Make the base path one
  documented value across the README, nginx and the filter.

### 3.3 State layout

The entrypoint treats "anything not in the image" as state, so every new
state file defaulting to the app root is one missed `.dockerignore` entry
away from being overwritten on update (`hidden-sessions.json` already is).
Give state one directory (`/app/state` or a `/data` volume) and default all
state paths into it. That is also the precondition for the ECS layout in 2.

## 4. Changes made alongside this report

| Area | Change | Test |
| --- | --- | --- |
| Login rate limit | Client IP from the socket, or the `X-Forwarded-For` hop chosen by `WEB_PI_TRUST_PROXY`, never the client-written leftmost entry. The limiter evicts instead of bulk-clearing. scrypt is async, at most 4 in flight (beyond that, 503), and runs even for a wrong username. | Rotating spoofed XFF still hits 429 |
| Crash resistance | WS frames validated against the message shapes; malformed `%` escapes give 400; JSON bodies must be objects; catch-alls on the request and message handlers. | Junk frames and paths leave the server and socket alive |
| Large pastes | Client splits input into 64 Ki-unit frames (surrogate-safe); server writes them whole. | 1.2 MB paste arrives byte-exact |
| Resume collisions | Resume tmux session is `r-<full id>` (hashed if too long). | Two UUIDv7 ids sharing an 8-char prefix get separate sessions |
| Dead connections | Server pings every 30 s; client shows "disconnected — reconnecting", reattaches with backoff, and never retries after the server's `exit`/`error`. | Dropped socket reattaches; killed session isn't retried |
| Signed-out deep links | Any page URL renders the login page in place, and sign-in reloads into it. | `/jobs` signed out → login → `/jobs` |
| Config | `WEB_PI_TRUST_PROXY` and `WEB_PI_HIDDEN_FILE` added to the typed schema; non-integer numbers stop the server at boot. | — |

## 5. Suggested order

1. Origin check and security headers (1.2): a small change that closes the
   remaining browser-side gaps.
2. Session lifecycle fixes (1.3) and a SIGTERM handler (1.4).
3. The state directory (3.3).
4. Decide the jobs/deployment question (3.1), and whether ECS is a real
   target (2).
5. The serving/working privilege split (1.1), before building the apps
   features on top.
