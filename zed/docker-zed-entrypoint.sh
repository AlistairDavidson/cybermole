#!/bin/sh
# docker-zed-entrypoint.sh — boots the Zed webapp container (profile
# `zed`, docs/zed-webapp.md): KasmVNC's X server + openbox + the folder
# launcher, all as the workspace user (uid 2000). Zed itself is lazy: the
# first folder-open (zed-launcher.py) boots it via the CLI's own
# fork-and-exec, and later opens reach the running instance over its CLI
# socket. Home is a named volume (settings, extensions, Zed state, the
# VNC password file) — seeded only where absent, like the repo's
# pi-agent template.
set -eu

: "${ZED_VNC_PASSWORD:?ZED_VNC_PASSWORD must be set (the browser client's login)}"
# Generated once by compose's zed-init onto /run/web-pi-zed/zed.env.
if [ -r /run/web-pi-zed/zed.env ]; then
  set -a
  . /run/web-pi-zed/zed.env
  set +a
fi
: "${WEB_PI_ZED_LAUNCH_TOKEN:?WEB_PI_ZED_LAUNCH_TOKEN is missing (zed-init did not run?)}"

export HOME=/home/workspace
export XDG_RUNTIME_DIR=/tmp/xdg-runtime
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.vnc" "$HOME/.config/zed"
chmod 700 "$XDG_RUNTIME_DIR"

# Window manager: seeded once; an operator edit on the volume wins.
if [ ! -x "$HOME/.vnc/xstartup" ]; then
  printf '#!/bin/sh\nexec openbox\n' > "$HOME/.vnc/xstartup"
  chmod 755 "$HOME/.vnc/xstartup"
fi
# Zed settings: auto_update off — the image pins the release; a silent
# self-update would desync it (and needs rsync). Seeded once, user edits win.
if [ ! -f "$HOME/.config/zed/settings.json" ]; then
  printf '{\n  "auto_update": false\n}\n' > "$HOME/.config/zed/settings.json"
fi

# Web-client login (basic auth against .kasmpasswd), regenerated from the
# env every boot — kasmvncpasswd reads the password from stdin twice.
# https://kasmweb.com/kasmvnc/docs/latest/man/vncpasswd.html
printf '%s\n%s\n' "$ZED_VNC_PASSWORD" "$ZED_VNC_PASSWORD" \
  | kasmvncpasswd -u kasm_user -w "$HOME/.kasmpasswd" >/dev/null
chmod 600 "$HOME/.kasmpasswd"

# X server + session (xstartup → openbox). Server config is baked at
# /etc/kasmvnc/kasmvnc.yaml (websocket :6901, dynamic resolution). The
# deb's wrapper is kasmvncserver (v1.5 ships no plain `vncserver`).
kasmvncserver :1 -geometry 1920x1080

# If Xvnc or the launcher dies the container should restart
# (restart: unless-stopped): supervise both, one polling loop. Zed
# itself is deliberately NOT supervised — a dead Zed is rebooted by the
# next folder-open (the CLI spawns the editor when its socket is absent).
echo "zed: streaming on :6901 (KasmVNC web client); launcher on :${ZED_LAUNCHER_PORT:-7999}"
python3 /opt/zed/zed-launcher.py &
LAUNCHER=$!
trap 'kill "$LAUNCHER" 2>/dev/null || true; exit 0' TERM INT
while :; do
  sleep 5
  kill -0 "$LAUNCHER" 2>/dev/null || { echo "zed: launcher died, exiting" >&2; exit 1; }
  pids=$(cat "$HOME"/.vnc/*:1.pid 2>/dev/null || true)
  if [ -z "$pids" ] || ! kill -0 "$pids" 2>/dev/null; then
    echo "zed: Xvnc died, exiting" >&2
    kill "$LAUNCHER" 2>/dev/null || true
    exit 1
  fi
done
