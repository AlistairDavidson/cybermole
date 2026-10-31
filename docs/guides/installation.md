# Installing cybermole (task/install-docs)

The consolidated install path. cybermole is **one host, one instance**,
single-user by design (sessions and rate limits are in-process state, the
tmux server is host-local — no multi-instance or load-balanced shape), so
"installing" means getting one running instance on one Linux box. There
are exactly two supported shapes, and this guide covers both end to end:

- **Path A — Docker compose** (recommended): the shipped privilege-split
  stack — web, workspace, editor, object storage — built from the repo's
  one image, serving on `127.0.0.1:3000` behind your TLS proxy.
- **Path B — plain host**: one Node process, one unix user, no Docker.
  The npm package is the channel; terminals run in your own tmux server
  under your own `$HOME`.

Both paths are scriptable: each has an install script under `deploy/`
(POSIX sh, idempotent, `--dry-run`) plus a matching uninstall, and every
step below is a copy-pasteable command with its expected outcome.

## How to read this guide (humans and agents)

This is written for two audiences at once: a human operator at a shell,
and an **LLM agent installing cybermole on someone's behalf**. For the
agent audience the rules are:

- **Follow verbatim, stop at the first divergence.** Every command shows
  what to expect; if the actual output differs, stop and report the
  command, the expected output, and the actual output — don't improvise
  past a failed precondition.
- **Never handle the password yourself.** No script sets the login
  password; the operator runs that one step (or pastes the command
  filled in). If you must run it with a piped password, take the secret
  from the operator out-of-band and never echo it into your transcript.
- **No network beyond the documented fetches**: Path A pulls Docker base
  images from the registry and, inside the image build, Debian apt
  packages + `npm ci` against the lockfile; Path B fetches the
  `cybermole` package from the npm registry. Nothing else phones out.
- Report back: the shape chosen, the versions the preflight printed, the
  verification result (the `curl` status line), and whether the password
  step is done — never the password.

Run everything as your normal unprivileged user unless a step says
otherwise. Neither path ever needs the checkout or the install to run as
root (Path B refuses to).

## What an install creates

| | Path A — compose | Path B — plain host |
|---|---|---|
| Processes | 5 containers (web, workspace, editor, seaweedfs + one-shots) | 1 Node process (`cybermole`), which supervises the editor |
| Uids | `node` serves; uid 2000 runs terminals (privilege split) | your user, for server and terminals |
| State | named volumes: `cybermole-state` (db), `cybermole-workspace` (files, pi creds), `cybermole-seaweedfs` + `cybermole-s3-credentials`, `cybermole-job-logs` | `~/.local/state/cybermole/` (db, pi agent dir, job logs, the editor build); editor settings + extensions in `~/.vscodium-server` |
| Bins on PATH | none (all inside the image) | `cybermole`, `cybermole-set-password`, `cybermole-cli` |
| Update | `git pull` + rebuild (or pull a published image) | `npm i -g cybermole@latest` |
| Uninstall | `deploy/uninstall-compose.sh [--purge]` | `deploy/uninstall-host.sh [--purge]` |

Both bind to `127.0.0.1` only and expect a TLS reverse proxy in front
before they are reachable from anywhere but the box itself
(README "Security model").

**Choosing:** if Docker is installed (or you may install it), take
Path A — it is the tested shape and keeps a prompt
injection inside a terminal away from the server's own state. Take
Path B on hosts without Docker, or when the workspaces should live in a
specific user's real home directory.

---

## Path A — Docker compose

### A0. Preflight

You need: Docker Engine with the compose plugin, `git`, ~3 GiB free disk
for the image build, and `127.0.0.1:3000` free. You do NOT need Node on
the host — it lives in the image.

The install script checks all of this before changing anything. A dry
run prints its mutations and the checks' results without doing anything:

```sh
sh deploy/install-compose.sh --dry-run
```

Expected: a `preflight ok: docker Docker version 2x.x.x, v2.xx.x, probe
http://127.0.0.1:3000/login` line (versions vary) followed by `dry-run %`
lines for `docker compose build`, `up -d`, and the readiness wait. Any
failure instead prints `ERROR:` with the specific fix (daemon not
reachable, compose plugin missing, wrong directory, port 3000 taken by
something else).

### A1. Get the checkout

```sh
git clone https://gitlab.com/alistairldavidson/cybermole.git
cd cybermole
```

Expected: a working tree containing `compose.yaml`, `deploy/`, `docs/`.
(Adjust the URL if you fork; everything below runs from inside this
checkout.)

### A2. Install

```sh
sh deploy/install-compose.sh
```

Expected, in order:

1. `preflight ok: …` (versions + probe URL),
2. the image build (minutes on a cold cache; the first `up` also runs the
   one-shot init containers that lay out volumes and generate the S3
   credentials),
3. `waiting for the web container to serve /login (first boot
   builds+boots; ~30-90s)`, then `serving http://127.0.0.1:3000/login`,
4. the next-steps summary with the set-password command.

The script wraps — never hides — its steps; the manual equivalents are
`docker compose build && docker compose up -d` plus the `/login` probe
the image's own healthcheck uses. Re-running it is safe: cached rebuild,
`up -d` no-ops when the stack is up, and the probe re-verifies. It does
NOT set the password and does NOT touch your dotfiles (that's the
opt-in `--with-shell-config`, A6).

### A3. Set the login password

Interactive (input hidden):

```sh
docker compose exec cybermole node dist-server/server/set-password.js
```

Expected prompts: `Username: `, `Password (input hidden): `,
`Repeat password: `, then `written: /state/cybermole.db`. The password
needs ≥ 8 characters. Agents: see "How to read this guide" — the
operator supplies the secret; a piped form exists
(`printf 'user\npass\npass\n' | …`) but must not put a real password in
your transcript.

### A4. Verify

```sh
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

Expected: `cybermole`, `workspace`, `editor`, `seaweedfs` and the init
one-shots reporting `running`/`exited (0)`, and `200`. Then sign in in a
browser on the box (`http://127.0.0.1:3000`) — or from your workstation
through an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 host`) — create a
workspace, and confirm the first terminal tab opens.

### A5. Put TLS in front (before exposing it anywhere)

The cookie is `Secure` and login POSTs must not cross plain HTTP.
`deploy/nginx/cybermole.conf` is the reference reverse-proxy block
(WebSocket upgrade map included; allows the 5 GiB upload body), and
`deploy/fail2ban/` watches failed logins. Compose already sets
`CYBERMOLE_TRUST_PROXY=1` for that one hop. Subpath deployments have a
three-file `CYBERMOLE_BASE` agreement — README "The base path"; apps pick
the base up automatically at scaffold/build (no extra nginx location —
`<base>/apps/<slug>/` rides the one base location), and a base change
means rebuilding each registered app (`build` + `reload`).

### A6. Terminal shell settings (zsh init)

Terminals run `zsh -l` (compose's `CYBERMOLE_COMMAND` default) as uid
2000 in the workspace container, whose `$HOME` is part of the image —
a fresh container boots into zsh's bare defaults, and it dies with the
container. Two mechanisms make that sane, both non-destructive
(only-where-absent: a config file already in the container's `$HOME`
always wins):

- **A minimal default** — the image ships `runtime/zsh/zshrc` (history,
  kept on the persistent workspace volume at
  `/workspace/.cybermole/zsh-history`; sensible prompt; `autocd`). The
  workspace entrypoint seeds it as `~/.zshrc` on every container start.
  You do nothing; this is what a default install boots into.
- **Your own dotfiles, opt-in** — the offer, declined by default:

  ```sh
  sh deploy/install-compose.sh --with-shell-config
  ```

  This copies `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.zlogin` —
  whichever of them exist for the user running the script — to
  `/workspace/.cybermole/shell` on the persistent workspace volume
  (normalized to `0644` so a private host dotfile stays readable for
  the terminal uid) and recreates the workspace container
  (`docker compose up -d --force-recreate workspace`) so its fresh
  `$HOME` is seeded from the staged copies — the container's `$HOME`
  is writable-layer state a plain restart would keep, and the default
  `~/.zshrc` from the `up` above already sits there, so only a fresh
  home applies the staging. Recreating ends live terminal tabs (they
  respawn fresh on their next attach) and discards in-`$HOME` edits —
  never the staged files or anything under `/workspace`. Host files
  are never modified.

Rules of the mechanism:

| Question | Answer |
|---|---|
| What gets seeded? | the four zsh files, each only if staged and absent from `$HOME`; `.zshrc` falls back to the image default when nothing is staged |
| What if the container user edits their `~/.zshrc`? | wins until the container is recreated (the seed is only-where-absent) |
| Re-apply after changing host dotfiles? | re-run `--with-shell-config` — it re-stages and recreates the workspace container (the manual equivalent: `docker compose up -d --force-recreate workspace`) |
| Remove a staged file? | `docker compose exec -u 0 workspace rm /workspace/.cybermole/shell/<file>` — `-u 0` because the staged copy's owner may be root or the host uid |
| The editor's integrated terminal? | same uid, but its `$HOME` is the persistent `cybermole-editor-home` volume — one-liner: `docker compose cp ~/.zshrc editor:/home/workspace/.zshrc` |
| Host paths in your dotfiles | your config may reference host-only paths (`~/.zshenv` exporting host tool paths is the classic) — stage a trimmed copy if it misbehaves |

The dev profile (`npm run dev`) overrides the entrypoint and runs as
your uid with a *container* `$HOME` (uid 1000 is `node`'s `/home/node`;
other uids get `/`) — it gets neither the default nor any staging, so
dev terminals boot a bare zsh. Seeding there is a deliberate follow-up:
same staged-dir mechanism, on the `/state` volume.

### A7. Updating

```sh
git pull
sh deploy/install-compose.sh
```

That is the whole flow: rebuild + `up -d` + verify. Web restarts leave
terminal sessions running (tmux lives in the workspace container);
workspace container restarts end live sessions. pi updates ride the
image, or live standalone on the workspace volume — README "Updating"
for the pi-specific flows and the published-image (`CYBERMOLE_IMAGE`)
pull path.

### A8. Uninstall

```sh
sh deploy/uninstall-compose.sh            # down; ALL state kept
sh deploy/uninstall-compose.sh --purge    # also volumes + images — destructive
```

Default keeps every volume (login db, all workspace files, uploads);
`up -d` in the checkout brings the same instance back. `--purge`
deletes the volumes (the workspace tree and pi credentials included) and
the built images; it is the consent. The checkout itself is never
touched.

---

## Path B — plain host

### B0. Preflight

You need: Linux, Node ≥ 22.13 (built-in `node:sqlite`), npm, `tmux` on
PATH, and usually a C++ toolchain (node-pty; a prebuilt binding often
makes it unnecessary). Check with the script's dry run, run from the
checkout (or anywhere — only the docs pointer assumes the repo):

```sh
sh deploy/install-host.sh --dry-run
```

Expected: `preflight ok: node v22.x.x, npm 10.x.x, tmux x.x, npm prefix
…, state dir ~/.local/state/cybermole`, then `dry-run %` lines for
`npm install -g cybermole`. Failures print `ERROR:` with the fix (node
too old, tmux missing, running as root — refused on purpose).

### B1. Install

```sh
sh deploy/install-host.sh --with-systemd-unit
```

Expected: `preflight ok: …`, then the npm install (if the npm prefix is
root-owned it goes through sudo — passwordless sudo must be configured,
else the script prints the exact command to run by hand and exits), the
bin check, the editor (`installing the editor (VSCodium reh-web …)` then
`editor installed`; it needs `curl`, `tar` and `sha256sum`, and an x64 or
arm64 host), and — with the flag — the systemd unit written to
`/etc/systemd/system/cybermole.service`, enabled and started
(`systemd unit active: systemctl status cybermole`). Manual equivalent
of the core step: `npm install -g cybermole`.

The unit runs the server as **the user who ran the script**, binds
loopback, and restarts on failure. Skip the flag to run the server in
the foreground (or under tmux) instead. Re-running the script is safe:
an existing install is left alone, the unit is rewritten and restarted.

The editor (the console's editor tab, VSCodium in the browser) is on by
default: the server supervises it whenever `~/.local/state/cybermole/editor`
holds an install. A failed editor download only warns, and cybermole runs
without the tab (re-run the script to retry). `--without-editor` skips it;
to switch off one that's installed, set `CYBERMOLE_EDITOR_UPSTREAM=`
(empty) in the server's environment. Details: docs/guides/editor-webapp.md.

Single-user blast radius: the web app, its terminals and your files
share this one uid — that is the documented trade-off of this shape
(README "Security model"); the two-user hardened equivalent on a plain
host is manual today (README "The same split on a plain host").

### B2. Set the login password

```sh
cybermole-set-password
```

Expected prompts: `Username: `, `Password (input hidden): `,
`Repeat password: `, then `written:
/home/<you>/.local/state/cybermole/cybermole.db` (or your
`CYBERMOLE_STATE_DIR`). Password ≥ 8 characters. Changing it later
revokes every session.

### B3. Verify

With the systemd unit:

```sh
systemctl is-active cybermole && curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

Expected: `active` then `200`. Without it, start `cybermole` in a
terminal (or `tmux new -s cybermole cybermole`) and run the same `curl`.
Then sign in over the loopback address (or an SSH tunnel) and open a
workspace — the first terminal tab auto-runs the vendored pi. The
server's log says `editor: single-user shape — supervising …` and the
workspace has an **editor** tab after its terminals.

### B4. Put TLS in front

Same story as A5, plus: the host install does NOT get
`CYBERMOLE_TRUST_PROXY` from anywhere — set it to `1` in the unit file
(uncomment the line) or the environment when nginx lands in front, or
the login rate limiter will bucket everyone as one client.

### B5. Terminal shell settings: nothing to do

This is the shape's point: `CYBERMOLE_COMMAND` defaults to `$SHELL -l`
and `HOME` is your real home, so your terminal tabs read your real
`~/.zshrc` (or `~/.bashrc`) exactly as a local shell would. The
staged-config mechanism from A6 does not exist here because nothing
needs it. Note the /settings page can pin per-install shell/agent
commands in the db (`CYBERMOLE_COMMAND` / `CYBERMOLE_AGENT_COMMAND`
overrides).

### B6. App agents can run app e2e (one-time)

On a host install the agents' browser for app e2e is not installed for
you — the compose image ships Playwright's chromium baked (see the app
build loop's note), the host path needs it once, from the install dir so
the pinned browser build matches the install's playwright:

```sh
cd <install dir>          # where node_modules has playwright
sudo -u <app user> -H npx playwright install chromium
```

That lands in `<app user>'s ~/.cache/ms-playwright`. If the launch then
complains about missing libraries, `npx playwright install-deps
chromium` names them (install with apt and rerun the browser step — the
verify probe is a two-line launch script). Without it, an app agent's
`npm run test:e2e` (its own tree's gate) fails at browser resolution, not
at any assertion.

### B7. Updating

```sh
npm i -g cybermole@latest        # or: sudo npm i -g cybermole@latest on a root-owned prefix
sudo systemctl restart cybermole # if the unit is installed (open terminals end; tabs respawn)
```

pi (the vendored agent) updates separately from `/settings` (the
"update pi" button) or with `npm install
@earendil-works/pi-coding-agent@latest` in the install dir — README
"Updating".

### B8. Uninstall

```sh
sh deploy/uninstall-host.sh            # unit + package; state KEPT
sh deploy/uninstall-host.sh --purge    # also deletes the state dir — destructive
```

State (login db, sessions, pi credentials, job logs, the editor build)
survives the default uninstall under `~/.local/state/cybermole` —
reinstalling picks it back up. `--purge` deletes it. The editor's own
settings and extensions in `~/.vscodium-server` are left either way.

---

## For agents: the short runbook

1. **Choose the path.** `docker info >/dev/null 2>&1` (or can you
   install Docker?) → Path A. No Docker and Node ≥ 22.13 is available →
   Path B. Neither → report back, don't half-install.
2. **Preflight dry-run first** (A0/B0) and confirm the checks pass.
3. **Install** (A2/B1), then **password** (A3/B2 — operator's secret),
   then **verify** (A4/B3). Report the verification line verbatim.
4. Do not configure observability, subpath bases, or other optional
   surfaces unless asked — each is documented in the README and off by
   default.

Common failure modes and their fixes:

| Failure | Meaning / fix |
|---|---|
| `docker daemon not reachable` | Docker isn't running or the user isn't in the `docker` group (`sudo usermod -aG docker $USER` + re-login) |
| `something other than this stack is listening on 127.0.0.1:3000` | free the port or remap the publish in compose.yaml |
| `not serving /login after 90s` | read `docker compose logs cybermole` — a port conflict or a bad `CYBERMOLE_BASE` agreement are the usual causes |
| `node … is too old` / `tmux not found` | install the listed versions (B0) |
| `need root for: npm install -g …` | run the printed sudo command by hand, then re-run the script (idempotent) |
| `unit is not active` | `systemctl status cybermole` / `journalctl -u cybermole` — a missing `tmux` on the unit's PATH is the classic (the script builds PATH from where it found node+tmux) |

## The scripts

| Script | Does | Flags |
|---|---|---|
| `deploy/install-compose.sh` | preflight (docker, compose, port, disk), `docker compose build` + `up -d`, readiness probe | `--dry-run`, `--with-shell-config` |
| `deploy/uninstall-compose.sh` | `docker compose down`; volumes/images only with `--purge` | `--dry-run`, `--purge` |
| `deploy/install-host.sh` | preflight (node/npm/tmux/toolchain), `npm i -g cybermole`, bin check, optional systemd unit | `--dry-run`, `--with-systemd-unit` |
| `deploy/uninstall-host.sh` | unit removal, `npm rm -g`; state dir only with `--purge` | `--dry-run`, `--purge` |

All four are POSIX `sh` (dash-safe) with `set -eu` and `pipefail`
enabled where the shell supports it, idempotent, and they never modify
the host's dotfiles or set secrets. **Linting:** the repo's gates
(ESLint, Prettier) do not cover shell; the scripts are kept
`shellcheck`-clean by hand — run `shellcheck deploy/*.sh` when you have
it. `sh deploy/<script> --help` prints the embedded usage.
