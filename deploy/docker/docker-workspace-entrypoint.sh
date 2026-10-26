#!/bin/sh
# cybermole workspace entrypoint — the working half of the privilege split
# (DESIGN_REVIEW §1.1). Runs as user `workspace` (uid 2000) from the SAME
# image as the web service: this container owns the tmux server and every
# pi session; the web container only ever attaches as a client. Verified
# mechanics (tmux 3.3a):
#   - the socket is created 0600 regardless of umask → chmod 0660 + chgrp
#     shared-group after start; the socket dir must be 2770 setgid (the
#     compose init container sets that up);
#   - `server-access -a <name>` admits the web user by NAME (resolved in
#     this container's /etc/passwd — same image, so `node` exists);
#   - umask 0007 here is inherited by everything the tmux server spawns
#     (panes, pi) — that is what makes pi's session files group-readable
#     so the web sidebar can list them without being able to write them;
#   - an empty tmux server dies instantly under default exit-empty, and a
#     separate `set-option` races that death — exit-empty off must ride
#     the conf read at server start.
# Idempotent on restart: a stale socket a dead server left behind (the
# socket dir is a shared volume) is detected and removed before start.
set -e

SOCKET=${CYBERMOLE_TMUX_SOCKET:-/run/cybermole/tmux}
WEB_USER=${CYBERMOLE_TMUX_WEB_USER:-node}
SHARED_GROUP=${CYBERMOLE_TMUX_GROUP:-cybermole}
CONF=${CYBERMOLE_TMUX_CONF:-/opt/cybermole/runtime/tmux.conf}
AGENT_DIR=${CYBERMOLE_AGENT_DIR:-/workspace/pi-agent}
TEMPLATE=/opt/cybermole/runtime/pi-agent-dir
ROOT_TEMPLATE=/opt/cybermole/runtime/workspace-root/AGENTS.md

umask 0007

# Fail loudly and early on a misconfigured web user — `server-access -a`
# refuses the server's own owner ("owns the server, can't change access")
# and an unknown name ("unknown user") late in boot, after the server is
# already up; refusing here is the clear failure.
if [ "$(id -un)" = "$WEB_USER" ]; then
  echo "cybermole workspace: CYBERMOLE_TMUX_WEB_USER ($WEB_USER) is the workspace user itself — set it to the WEB side's user" >&2
  exit 1
fi
if ! id -u "$WEB_USER" >/dev/null 2>&1; then
  echo "cybermole workspace: CYBERMOLE_TMUX_WEB_USER ($WEB_USER) is not a user in this image" >&2
  exit 1
fi

# Stale socket from a dead server (container restart): if nothing answers
# the liveness probe, remove it — start-server must not find a dead file.
# show-options -g needs no session and never forks a server.
if [ -S "$SOCKET" ] && ! tmux -S "$SOCKET" show-options -g >/dev/null 2>&1; then
  echo "cybermole workspace: removing stale tmux socket $SOCKET"
  rm -f "$SOCKET"
fi

# Seed the runtime pi-agent from the repo's versioned template (runtime/pi-agent-dir/) —
# the same only-where-absent policy the web server applies in single-user
# shapes (server/main.ts seedAgentDir): existing files always win, state
# only pi writes (auth.json, sessions/) is never in the template. Seeding
# HERE (uid 2000) rather than web-side keeps every file workspace-owned —
# web-side cp's would leave node-owned 0644 files pi cannot write next
# to. setgid group dirs + umask 0007 keep pi's later writes group-shared.
if [ -d "$TEMPLATE" ]; then
  (cd "$TEMPLATE" && find . -type f) | while IFS= read -r f; do
    if [ ! -e "$AGENT_DIR/$f" ]; then
      mkdir -p "$(dirname "$AGENT_DIR/$f")"
      cp "$TEMPLATE/$f" "$AGENT_DIR/$f"
    fi
  done
fi

# jobs-agent-plan §9: the workspace-root AGENTS.md — the root agent's
# standing instructions (scheduled work belongs in jobs; a fired run is
# started-not-finished; the CLI + MCP surface) — seeded from the repo's
# one-file template into the default workspace cwd (the root: /workspace
# in this shape; CYBERMOLE_NEW_SESSION_CWD names the same path web-side),
# same only-where-absent policy: an existing file (the operator's own, a
# checkout that IS the cwd) always wins.
ROOT_AGENTS="${CYBERMOLE_NEW_SESSION_CWD:-/workspace}/AGENTS.md"
if [ -f "$ROOT_TEMPLATE" ] && [ ! -e "$ROOT_AGENTS" ]; then
  cp "$ROOT_TEMPLATE" "$ROOT_AGENTS"
fi

# task/install-docs: zsh init — the shipped terminal default is `zsh -l`
# (CYBERMOLE_COMMAND in compose), and the terminal user's home is
# image-layer: it dies with the container, so a fresh container boots into
# zsh's bare defaults. Seed the four files a login zsh reads, only-where-
# absent — a file already in $HOME always wins (edits made inside a running
# container), and a copy the operator staged from their host dotfiles beats
# the image's minimal default (runtime/zsh/zshrc). Staging is the opt-in
# half: deploy/install-compose.sh --with-shell-config copies into
# /workspace/.cybermole/shell on the persistent workspace volume (see
# docs/guides/installation.md, "Shell settings"). Best-effort like the
# notes seeding below: an unreadable staged file (a 0600 host dotfile)
# must warn and continue, never keep the tmux server from starting.
SHELL_HOME=${CYBERMOLE_HOME:-$HOME}
SHELL_STAGED=/workspace/.cybermole/shell
SHELL_DEFAULT=/opt/cybermole/runtime/zsh/zshrc
SHELL_SEEDED=
for f in .zshenv .zprofile .zshrc .zlogin; do
  if [ -e "$SHELL_HOME/$f" ]; then
    continue
  fi
  if [ -f "$SHELL_STAGED/$f" ]; then
    if cp "$SHELL_STAGED/$f" "$SHELL_HOME/$f" 2>/dev/null; then
      SHELL_SEEDED="$SHELL_SEEDED $f(staged)"
    else
      echo "cybermole workspace: could not seed $f from $SHELL_STAGED/$f (unreadable?) — continuing" >&2
    fi
  elif [ "$f" = .zshrc ] && [ -f "$SHELL_DEFAULT" ]; then
    if cp "$SHELL_DEFAULT" "$SHELL_HOME/$f" 2>/dev/null; then
      SHELL_SEEDED="$SHELL_SEEDED $f(default)"
    else
      echo "cybermole workspace: could not seed $f from $SHELL_DEFAULT — continuing" >&2
    fi
  fi
done
if [ -n "$SHELL_SEEDED" ]; then
  echo "cybermole workspace: seeded zsh config into $SHELL_HOME (only where absent):$SHELL_SEEDED"
elif [ ! -e "$SHELL_HOME/.zshrc" ]; then
  echo "cybermole workspace: no zsh config to seed — stage the host operator's dotfiles with deploy/install-compose.sh --with-shell-config"
fi

# task/app-notes: the reference app — the notes
# tree ships in the image at /opt/cybermole/runtime/reference-apps/notes as
# living documentation of a FINISHED app tree, and seeds into the
# install's apps root ONLY-WHERE-ABSENT (the same policy the lines
# above apply to the pi template): an existing tree always wins (the
# operator's own notes app, their data/ — never touched), and NOTHING
# AUTO-REGISTERS — registration is the privileged act (§8). The seeded
# tree stands unregistered; the root agent's `status` shows it among
# the unregistered trees and one `register` + `reload` makes it live.
# git + the node_modules links are best-effort (a tree without its git
# repo or links still serves once checked; the root agent's check tool
# names the fix) — a seeding failure must never stop the boot.
APPS_ROOT_DIR="${CYBERMOLE_APPS_ROOT:-/workspace/apps}"
REFERENCE_TREE=/opt/cybermole/runtime/reference-apps/notes
if [ -d "$REFERENCE_TREE" ] && [ ! -d "$APPS_ROOT_DIR/notes" ]; then
  mkdir -p "$APPS_ROOT_DIR"
  if cp -a "$REFERENCE_TREE" "$APPS_ROOT_DIR/notes" 2>/dev/null; then
    if command -v git >/dev/null 2>&1; then
      (
        cd "$APPS_ROOT_DIR/notes"
        git init -b main -q
        git add -A
        git -c user.name=cybermole-apps -c user.email=cybermole-apps@localhost \
          commit -q -m 'seed the notes reference app from the image'
      ) || echo "cybermole workspace: could not git-init the seeded notes tree — continuing" >&2
    fi
    (
      cd "$APPS_ROOT_DIR/notes"
      node scripts/setup-node-modules.mjs
    ) || echo "cybermole workspace: notes tree node_modules links failed — run npm run setup in the tree" >&2
    echo "cybermole workspace: seeded the notes reference app at $APPS_ROOT_DIR/notes (unregistered — register + reload to serve it)"
  fi
fi

# Server conf: the app's tmux.conf + exit-empty off (see header). The
# combined file is ephemeral — server-side state, not shared.
SERVER_CONF=$(mktemp)
[ ! -f "$CONF" ] || cat "$CONF" >> "$SERVER_CONF"
echo "set -g exit-empty off" >> "$SERVER_CONF"
tmux -S "$SOCKET" -f "$SERVER_CONF" start-server
rm -f "$SERVER_CONF"

chmod 0660 "$SOCKET"
chgrp "$SHARED_GROUP" "$SOCKET"
tmux -S "$SOCKET" server-access -a "$WEB_USER"

echo "cybermole workspace: tmux server on $SOCKET (web user: $WEB_USER, group: $SHARED_GROUP, pi agent dir: $AGENT_DIR)"

# task/app-host: the app host — the SECOND
# supervised child, after the tmux server, same uid/env. It listens on
# CYBERMOLE_APPS_SOCK (0660 after its own listen; the setgid socket dir
# gives it the shared group) and mounts registered apps' built Astro
# middlewares. It needs the internal API (CYBERMOLE_SOCK, served by the
# web container) and retries discovery until it answers — the compose
# boot race — so it may start before the web server is up.
#
# OWNERSHIP RULE (plan §3, the CYBERMOLE_TMUX_SOCKET precedent): in the
# compose SPLIT, THIS entrypoint owns the app host — the web container
# NEVER spawns it (web is only a client on the socket, branch 2's
# /apps/* proxy). A SET CYBERMOLE_APPS_SOCK on a plain host = the
# operator owns the process (systemd, a terminal). Single-user shapes
# (the default socket, no split) spawn it from the web server's main.ts
# as a supervised child instead — that wiring is a LATER branch of the
# epic (branch 2, task/app-web); nothing here covers it.
APP_HOST_PID=
start_app_host() {
  node /opt/cybermole/dist-server/server/app-host.js &
  APP_HOST_PID=$!
  echo "cybermole workspace: app host started (pid $APP_HOST_PID, socket ${CYBERMOLE_APPS_SOCK:-<shape default>})"
}

# Unset = the shape default (env.ts: /run/cybermole/apps.sock here — on);
# set-and-empty = the apps surface is OFF — no host, and every client
# (the web proxy, reload, the shim) fails with its clear error.
if [ "${CYBERMOLE_APPS_SOCK+set}" != "set" ] || [ -n "$(echo "$CYBERMOLE_APPS_SOCK" | tr -d '[:space:]')" ]; then
  start_app_host
else
  echo "cybermole workspace: apps surface off (CYBERMOLE_APPS_SOCK empty) — no app host"
fi

# This container's whole job is keeping the tmux server (and now the app
# host) alive — web's never-fork guard depends on the tmux server.
# tmux's death ends the container (docker's restart policy brings it,
# and a fresh server, back); the app host's death restarts ONLY the app
# host — neither child takes the other down, and a crashing host never
# costs the terminals. 10s poll granularity, the old loop's cadence.
while :; do
  if ! tmux -S "$SOCKET" show-options -g >/dev/null 2>&1; then
    echo "cybermole workspace: tmux server exited"
    if [ -n "$APP_HOST_PID" ]; then
      kill "$APP_HOST_PID" 2>/dev/null || true
      wait "$APP_HOST_PID" 2>/dev/null || true
    fi
    exit 1
  fi
  if [ -n "$APP_HOST_PID" ] && ! kill -0 "$APP_HOST_PID" 2>/dev/null; then
    echo "cybermole workspace: app host (pid $APP_HOST_PID) exited — restarting it"
    start_app_host
  fi
  sleep 10
done
