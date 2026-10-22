#!/bin/sh
# web-pi workspace entrypoint — the working half of the privilege split
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

SOCKET=${WEB_PI_TMUX_SOCKET:-/run/web-pi/tmux}
WEB_USER=${WEB_PI_TMUX_WEB_USER:-node}
SHARED_GROUP=${WEB_PI_TMUX_GROUP:-webpi}
CONF=${WEB_PI_TMUX_CONF:-/opt/web-pi/tmux.conf}
AGENT_DIR=${WEB_PI_AGENT_DIR:-/workspace/pi-agent}
TEMPLATE=/opt/web-pi/pi
ROOT_TEMPLATE=/opt/web-pi/root-agents/AGENTS.md

umask 0007

# Fail loudly and early on a misconfigured web user — `server-access -a`
# refuses the server's own owner ("owns the server, can't change access")
# and an unknown name ("unknown user") late in boot, after the server is
# already up; refusing here is the clear failure.
if [ "$(id -un)" = "$WEB_USER" ]; then
  echo "web-pi workspace: WEB_PI_TMUX_WEB_USER ($WEB_USER) is the workspace user itself — set it to the WEB side's user" >&2
  exit 1
fi
if ! id -u "$WEB_USER" >/dev/null 2>&1; then
  echo "web-pi workspace: WEB_PI_TMUX_WEB_USER ($WEB_USER) is not a user in this image" >&2
  exit 1
fi

# Stale socket from a dead server (container restart): if nothing answers
# the liveness probe, remove it — start-server must not find a dead file.
# show-options -g needs no session and never forks a server.
if [ -S "$SOCKET" ] && ! tmux -S "$SOCKET" show-options -g >/dev/null 2>&1; then
  echo "web-pi workspace: removing stale tmux socket $SOCKET"
  rm -f "$SOCKET"
fi

# Seed the runtime pi-agent from the repo's versioned template (pi/) —
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
# in this shape; WEB_PI_NEW_SESSION_CWD names the same path web-side),
# same only-where-absent policy: an existing file (the operator's own, a
# checkout that IS the cwd) always wins.
ROOT_AGENTS="${WEB_PI_NEW_SESSION_CWD:-/workspace}/AGENTS.md"
if [ -f "$ROOT_TEMPLATE" ] && [ ! -e "$ROOT_AGENTS" ]; then
  cp "$ROOT_TEMPLATE" "$ROOT_AGENTS"
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

echo "web-pi workspace: tmux server on $SOCKET (web user: $WEB_USER, group: $SHARED_GROUP, pi agent dir: $AGENT_DIR)"

# This container's whole job is keeping the tmux server alive (web's
# never-fork guard depends on it). Exit when the server dies — docker's
# restart policy brings the container (and a fresh server) back.
while tmux -S "$SOCKET" show-options -g >/dev/null 2>&1; do
  sleep 10
done
echo "web-pi workspace: tmux server exited"
exit 1
