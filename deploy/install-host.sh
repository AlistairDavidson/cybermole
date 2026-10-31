#!/bin/sh
# Install cybermole on a plain Linux host — the no-Docker shape (README
# "Deploying"): ONE Node process serving everything on loopback
# 127.0.0.1:3000, one unix user (you — run it under a normal unprivileged
# account, never root), terminals in your own tmux server under your own
# $HOME. Installs the published npm package (`npm install -g cybermole`)
# and the editor (the only network fetches), verifies the bins, and
# optionally installs a systemd unit so the server survives logout/reboot.
#
# The editor (VSCodium reh-web, docs/guides/editor-webapp.md) installs by
# default: the pinned, sha256-verified tarball unpacks to $STATE_DIR/editor
# with the bundled extensions, and the server supervises it on a private
# socket whenever it finds it there. Pins match deploy/editor/Dockerfile
# (tests/unit/editor.test.mjs holds them together); a re-run with new
# pins replaces it.
#
# Idempotent: an installed cybermole is detected and left alone (upgrade
# with `npm i -g cybermole@latest`), and the unit is rewritten, reloaded
# and restarted if it was running.
#
# The login password is deliberately NOT set here (it is a secret — run
# the set-password step from docs/guides/installation.md yourself).
#
# Flags:
#   --dry-run            print each mutation, change nothing (checks run)
#   --with-systemd-unit  also install /etc/systemd/system/cybermole.service
#                        running the server as THIS user, enabled at boot.
#                        Needs root: uses sudo (passwordless or already
#                        cached — the script refuses to hang on a prompt).
#   --without-editor     skip the editor (an installed one is left alone;
#                        CYBERMOLE_EDITOR_UPSTREAM= (empty) switches it off)
#
# Single-user shape, single-uid blast radius: a terminal in the web app is
# a shell as this user, and the served app tree is writable by it. The
# hardened equivalent (two unix users over one shared tmux socket) is
# manual today — README "The same split on a plain host".
set -eu
# pipefail where the shell has it (POSIX sh does not promise it)
# shellcheck disable=SC3040
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

DRY_RUN=0
WITH_UNIT=0
WITH_EDITOR=1

info() { printf 'cybermole-install: %s\n' "$*"; }
warn() { printf 'cybermole-install: WARNING: %s\n' "$*" >&2; }
die() { printf 'cybermole-install: ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --with-systemd-unit) WITH_UNIT=1 ;;
    --without-editor) WITH_EDITOR=0 ;;
    -h | --help) usage 0 ;;
    *) printf 'unknown flag: %s\n\n' "$arg" >&2; usage 1 >&2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'dry-run %% %s\n' "$*"
  else
    "$@"
  fi
}

# `sudo CMD` only when passwordless sudo works (or nothing runs at all in
# a dry-run); otherwise fail loudly with the manual command — an agent
# must never sit in an invisible prompt.
sudo_run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'dry-run %% sudo %s\n' "$*"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo "$@"
  else
    die "need root for: $* — run it by hand (sudo $*), then re-run this script"
  fi
}

# ---------- preflight ----------

[ "$(uname -s)" = Linux ] || die "Linux only (node-pty + tmux) — this is $(uname -s)"
[ "$(id -u)" -ne 0 ] || die "refusing to run as root — cybermole is a web shell as its own user; install and run it as a normal user (README: 'Run under a dedicated unprivileged user')"
command -v node >/dev/null 2>&1 || die "node not found on PATH — install Node >= 22.13 (nodejs.org, or your distro/nvm)"

node_ok=$(node -p 'const v = process.versions.node.split(".").map(Number); v[0] > 22 || (v[0] === 22 && v[1] >= 13)')
[ "$node_ok" = true ] || die "node $(node --version) is too old — need >= 22.13 (built-in node:sqlite)"
command -v npm >/dev/null 2>&1 || die "npm not found on PATH (it ships with node)"
command -v tmux >/dev/null 2>&1 || die "tmux not found on PATH — every terminal tab is one tmux session (apt install tmux / dnf install tmux)"
if ! command -v cc >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then
  warn "no C++ compiler found — node-pty builds a native module; a prebuilt binding may still install, else 'apt install build-essential python3' and re-run 'npm install -g cybermole'"
fi

NPM_PREFIX=$(npm prefix -g)
STATE_DIR=${CYBERMOLE_STATE_DIR:-"$HOME/.local/state/cybermole"}
info "preflight ok: node $(node --version), npm $(npm --version), tmux $(tmux -V | cut -d' ' -f2), npm prefix $NPM_PREFIX, state dir $STATE_DIR"

# ---------- install the package ----------

if [ -x "$NPM_PREFIX/bin/cybermole" ]; then
  info "cybermole already installed at $NPM_PREFIX/bin/cybermole — leaving it (update: npm i -g cybermole@latest)"
else
  if [ -w "$NPM_PREFIX" ]; then
    run npm install -g cybermole
  else
    info "npm prefix $NPM_PREFIX is root-owned — installing with sudo (updates later: sudo npm i -g cybermole@latest)"
    sudo_run npm install -g cybermole
  fi
fi

if [ "$DRY_RUN" -eq 0 ]; then
  for bin in cybermole cybermole-set-password cybermole-cli; do
    [ -x "$NPM_PREFIX/bin/$bin" ] || die "the $bin bin is missing under $NPM_PREFIX/bin — check 'npm prefix -g' and the npm output above"
  done
fi

# ---------- the editor (default on) ----------

# Keep in step with deploy/editor/Dockerfile (tests/unit/editor.test.mjs).
VSCODIUM_VERSION=1.140.06880
VSCODIUM_SHA256_X64=f16388ea58170613c6d5e492aa10410a471e1d86d8cb343e3c8147493a7981a9
VSCODIUM_SHA256_ARM64=d21cccd1f21f0960b0b4ecb366149a6883bd1c5c5ecd0b32d44e65a618096a9f
ASTRO_EXT_VERSION=2.16.20
ASTRO_EXT_SHA256_X64=5ca31435f5440daf79e0e3cc5e7ff07f099762a2d579268d2af82f066fd195d3
ASTRO_EXT_SHA256_ARM64=472e3dc42682ff93651487428cb8937430c8a57b708c9ba18f84fb86df263fb0
ESLINT_EXT_VERSION=3.0.34
ESLINT_EXT_SHA256=ca5334d46f6a39079e751ef4601bfc9f86bc3a46483e87291ec609239d161308
PRETTIER_EXT_VERSION=12.4.0
PRETTIER_EXT_SHA256=fb730ea4306d09cdc0a3aaa9e9baae28058cc97a4fbfce8b056b377a0639a9fe
PLAYWRIGHT_EXT_VERSION=1.1.19
PLAYWRIGHT_EXT_SHA256=23fa3d9a97596935a13ebc546172a262cfa16eb95f4c3ce0d81a4153ce7a50ce
YAML_EXT_VERSION=2.0.2026101408
YAML_EXT_SHA256=85496e5cd9255de4ba777e6f848a95a62466baa939556773b4570acb629ca9b9

EDITOR_DIR="$STATE_DIR/editor"
EDITOR_MARKER="$EDITOR_DIR/.cybermole-editor-version"
OPEN_VSX=https://open-vsx.org/api
EDITOR_TMP=

# fetch_verified URL FILE SHA256: download and check, or return non-zero.
fetch_verified() {
  curl -fsSL -o "$2" "$1" || { warn "download failed: $1"; return 1; }
  echo "$3  $2" | sha256sum -c - >/dev/null 2>&1 || { warn "sha256 mismatch: $1"; return 1; }
}

# Everything lands in a scratch dir first and only a complete download
# replaces $EDITOR_DIR, so a failure leaves the previous editor (or none).
install_editor() {
  case "$(uname -m)" in
    x86_64) ARCH=x64; SHA=$VSCODIUM_SHA256_X64; ASTRO_SHA=$ASTRO_EXT_SHA256_X64 ;;
    aarch64 | arm64) ARCH=arm64; SHA=$VSCODIUM_SHA256_ARM64; ASTRO_SHA=$ASTRO_EXT_SHA256_ARM64 ;;
    *) warn "no VSCodium reh-web build for $(uname -m)"; return 1 ;;
  esac
  for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || { warn "$tool not found on PATH"; return 1; }
  done
  # The extensions are part of the pin: bumping any of them re-installs.
  WANT="vscodium-$VSCODIUM_VERSION-$ARCH astro-$ASTRO_EXT_VERSION eslint-$ESLINT_EXT_VERSION prettier-$PRETTIER_EXT_VERSION playwright-$PLAYWRIGHT_EXT_VERSION yaml-$YAML_EXT_VERSION"
  if [ "$(cat "$EDITOR_MARKER" 2>/dev/null || true)" = "$WANT" ]; then
    info "editor already installed at $EDITOR_DIR (VSCodium $VSCODIUM_VERSION) — leaving it"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'dry-run %% fetch + verify VSCodium reh-web %s (%s) and 5 extensions, unpack to %s\n' \
      "$VSCODIUM_VERSION" "$ARCH" "$EDITOR_DIR"
    return 0
  fi
  info "installing the editor (VSCodium reh-web $VSCODIUM_VERSION, $ARCH) to $EDITOR_DIR"
  mkdir -p "$STATE_DIR" || return 1
  EDITOR_TMP=$(mktemp -d "$STATE_DIR/.editor-install.XXXXXX") || return 1
  fetch_verified \
    "https://github.com/VSCodium/vscodium/releases/download/$VSCODIUM_VERSION/vscodium-reh-web-linux-$ARCH-$VSCODIUM_VERSION.tar.gz" \
    "$EDITOR_TMP/codium.tar.gz" "$SHA" || return 1
  mkdir "$EDITOR_TMP/editor" "$EDITOR_TMP/ext" || return 1
  tar -xzf "$EDITOR_TMP/codium.tar.gz" -C "$EDITOR_TMP/editor" || { warn "could not unpack the tarball"; return 1; }
  rm -f "$EDITOR_TMP/codium.tar.gz"
  "$EDITOR_TMP/editor/bin/codium-server" --version >/dev/null 2>&1 || { warn "the editor build does not run on this host"; return 1; }

  fetch_verified "$OPEN_VSX/astro-build/astro-vscode/linux-$ARCH/$ASTRO_EXT_VERSION/file/astro-build.astro-vscode-$ASTRO_EXT_VERSION@linux-$ARCH.vsix" \
    "$EDITOR_TMP/ext/astro.vsix" "$ASTRO_SHA" || return 1
  fetch_verified "$OPEN_VSX/dbaeumer/vscode-eslint/$ESLINT_EXT_VERSION/file/dbaeumer.vscode-eslint-$ESLINT_EXT_VERSION.vsix" \
    "$EDITOR_TMP/ext/eslint.vsix" "$ESLINT_EXT_SHA256" || return 1
  fetch_verified "$OPEN_VSX/esbenp/prettier-vscode/$PRETTIER_EXT_VERSION/file/esbenp.prettier-vscode-$PRETTIER_EXT_VERSION.vsix" \
    "$EDITOR_TMP/ext/prettier.vsix" "$PRETTIER_EXT_SHA256" || return 1
  fetch_verified "$OPEN_VSX/ms-playwright/playwright/$PLAYWRIGHT_EXT_VERSION/file/ms-playwright.playwright-$PLAYWRIGHT_EXT_VERSION.vsix" \
    "$EDITOR_TMP/ext/playwright.vsix" "$PLAYWRIGHT_EXT_SHA256" || return 1
  fetch_verified "$OPEN_VSX/redhat/vscode-yaml/$YAML_EXT_VERSION/file/redhat.vscode-yaml-$YAML_EXT_VERSION.vsix" \
    "$EDITOR_TMP/ext/yaml.vsix" "$YAML_EXT_SHA256" || return 1

  rm -rf "$EDITOR_DIR" && mv "$EDITOR_TMP/editor" "$EDITOR_DIR" || return 1
  # Into ~/.vscodium-server, where the supervised server reads them;
  # offline (local files). A miss only loses that one extension.
  for vsix in "$EDITOR_TMP"/ext/*.vsix; do
    "$EDITOR_DIR/bin/codium-server" --install-extension "$vsix" >/dev/null 2>&1 ||
      warn "extension install failed: $vsix (install it from Open VSX inside the editor)"
  done
  printf '%s\n' "$WANT" >"$EDITOR_MARKER" || return 1
  EDITOR_CHANGED=1
  info "editor installed — the server supervises it from its next (re)start"
}

# Never fatal: cybermole runs without the editor (the tab just isn't there).
EDITOR_CHANGED=0
if [ "$WITH_EDITOR" -eq 1 ]; then
  install_editor || warn "editor not installed — cybermole runs without it; re-run this script to retry (or pass --without-editor)"
  [ -z "$EDITOR_TMP" ] || rm -rf "$EDITOR_TMP"
else
  info "skipping the editor (--without-editor)"
fi

# ---------- optional: the systemd unit ----------

if [ "$WITH_UNIT" -eq 1 ]; then
  command -v systemctl >/dev/null 2>&1 || die "--with-systemd-unit needs systemctl"
  [ -d /run/systemd/system ] || die "systemd is not the init system here (no /run/systemd/system) — run the server yourself: cybermole (or inside tmux)"

  NODE_BIN=$(command -v node)
  TMUX_BIN=$(command -v tmux)
  APP_MAIN="$NPM_PREFIX/lib/node_modules/cybermole/dist-server/server/main.js"
  UNIT_PATH=/etc/systemd/system/cybermole.service
  # The unit's PATH must find tmux (terminals) and npm (the /settings
  # update button) wherever this box keeps them.
  PATH_ENV="$(dirname "$NODE_BIN"):$(dirname "$TMUX_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  STATE_ENV=
  [ -z "${CYBERMOLE_STATE_DIR:-}" ] || STATE_ENV="Environment=CYBERMOLE_STATE_DIR=$CYBERMOLE_STATE_DIR
"
  if [ "$DRY_RUN" -eq 0 ]; then
    [ -f "$APP_MAIN" ] || die "$APP_MAIN not found — unexpected npm layout, unit not written"
  fi
  UNIT=$(cat <<EOF
# cybermole — installed by deploy/install-host.sh (docs/guides/installation.md).
# Single-user shape: the server, its terminals and your files share THIS
# user; the terminal is the product, so ProtectSystem-style hardening buys
# nothing here. Loopback bind; front it with TLS (deploy/nginx/) and set
# CYBERMOLE_TRUST_PROXY=1 when a proxy hop lands in front.
[Unit]
Description=cybermole - self-hosted web terminal console
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
Environment=HOME=$HOME
Environment=PATH=$PATH_ENV
Environment=CYBERMOLE_HOST=127.0.0.1
${STATE_ENV}#Environment=CYBERMOLE_TRUST_PROXY=1
ExecStart=$NODE_BIN $APP_MAIN
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'dry-run %% write %s:\n%s\n' "$UNIT_PATH" "$UNIT"
  else
    printf '%s\n' "$UNIT" | sudo tee "$UNIT_PATH" >/dev/null
  fi
  sudo_run systemctl daemon-reload
  sudo_run systemctl enable --now cybermole
  if [ "$DRY_RUN" -eq 0 ]; then
    # A re-run may have changed the unit — restart so what runs is what
    # was written (open terminals die; they respawn as fresh tabs).
    if systemctl is-active --quiet cybermole; then
      sudo_run systemctl restart cybermole
    fi
    sleep 1
    systemctl is-active --quiet cybermole || die "unit is not active — 'systemctl status cybermole' and 'journalctl -u cybermole' say why"
    info "systemd unit active: systemctl status cybermole (logs: journalctl -u cybermole -f)"
  fi
fi

# ---------- what's next (the guide has the full steps) ----------

cat <<EOF

cybermole is installed$([ "$WITH_UNIT" -eq 1 ] && echo ' and running under systemd').

Next, set the login password (interactive — or pipe it, see the guide):

  cybermole-set-password
EOF

if [ "$EDITOR_CHANGED" -eq 1 ] && [ "$WITH_UNIT" -eq 0 ]; then
  cat <<'EOF'

A cybermole server that is already running picks up the editor when it
next restarts.
EOF
fi

if [ "$WITH_UNIT" -eq 1 ]; then
  cat <<'EOF'
The server is already up. Verify:
EOF
else
  cat <<'EOF'
Then start the server:

  cybermole   # serves http://127.0.0.1:3000; Ctrl-C stops it — use the
              # systemd unit (sh deploy/install-host.sh --with-systemd-unit)
              # or a tmux session to keep it running across logouts
EOF
fi
cat <<'EOF'

  curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
  # expected: 200

It binds to loopback by design — front it with TLS (deploy/nginx/) before
exposing it anywhere. Full install/update/uninstall story:
docs/guides/installation.md
EOF
