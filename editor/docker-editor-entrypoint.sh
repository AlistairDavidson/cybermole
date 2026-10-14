#!/bin/sh
# docker-editor-entrypoint.sh — boots the VSCodium reh-web editor container
# (profile `editor`, docs/editor-webapp.md). One process: the tarball's own
# server component, as the workspace user (uid 2000), with umask 0007 so
# what the editor writes under /workspace stays group-shared (the same
# discipline as the workspace half of the split).
#
# Flags are pinned by the spike (docs/editor-spike.md):
#   --server-base-path ${WEB_PI_BASE%/}/editor  the proxy mounts the app at
#       <base>/editor and the workbench's asset URLs must line up;
#   --without-connection-token  auth is upstream — web-pi's session gate;
#   --disable-workspace-trust  every folder opens trusted, no dialog. The
#       trust feature's threat model (running tasks/builds from checkouts
#       you don't control) is already this container's status quo: the
#       session-gated editor IS the same uid-2000 shell the terminal tab
#       grants, so gating it on itself buys nothing — and the dialog's
#       choice persists browser-side (APPLICATION_SHARED storage lives in
#       the browser, not the home volume), so without this it would nag
#       once per folder per browser forever;
#   --telemetry-level off  VSCodium ships no telemetry; pin the intent.
# No license flag is needed (verified: the server boots without it).
#
# Server data (user-data, extensions, logs) lands under $HOME
# (.vscodium-server, .local/state/VSCodium) — the persistent
# webpi-editor-home volume — so settings and installed extensions survive
# recreations.
set -eu

umask 0007
export HOME=/home/workspace
mkdir -p "$HOME"

# Bundled extensions (image-pinned .vsixs at /opt/editor-bundled-extensions,
# editor/Dockerfile) install into the home volume's extensions dir before
# the server starts. A marker keyed on the .vsix set's hashes makes it a
# no-op on later boots and re-runs exactly when the image's pins move;
# installs are offline (local files — the CLI never touches the gallery),
# and anything the user installs or removes from Open VSX afterwards is
# theirs: the marker only ever (re)adds the bundled set. A failure here
# degrades to an editor without the bundle, not to a dead container.
BUNDLED_DIR=/opt/editor-bundled-extensions
MARKER="$HOME/.vscodium-server/.webpi-bundled-extensions"
if [ -d "$BUNDLED_DIR" ] && ls "$BUNDLED_DIR"/*.vsix >/dev/null 2>&1; then
  WANT="$(sha256sum "$BUNDLED_DIR"/*.vsix | sha256sum | cut -d' ' -f1)"
  if [ "$(cat "$MARKER" 2>/dev/null || true)" != "$WANT" ]; then
    echo "web-pi editor: installing bundled extensions" >&2
    mkdir -p "$HOME/.vscodium-server"
    ok=0
    for vsix in "$BUNDLED_DIR"/*.vsix; do
      /opt/editor/bin/codium-server --install-extension "$vsix" >/dev/null \
        && ok=$((ok + 1)) || echo "web-pi editor: extension install failed: $vsix" >&2
    done
    [ "$ok" -eq "$(ls "$BUNDLED_DIR"/*.vsix | wc -l)" ] \
      && printf '%s\n' "$WANT" > "$MARKER" \
      || echo "web-pi editor: incomplete bundle install; will retry next boot" >&2
  fi
fi

exec /opt/editor/bin/codium-server \
  --host 0.0.0.0 \
  --port 3000 \
  --server-base-path "${WEB_PI_BASE%/}/editor" \
  --without-connection-token \
  --disable-workspace-trust \
  --telemetry-level off
