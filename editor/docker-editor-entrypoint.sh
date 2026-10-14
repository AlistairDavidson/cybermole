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

exec /opt/editor/bin/codium-server \
  --host 0.0.0.0 \
  --port 3000 \
  --server-base-path "${WEB_PI_BASE%/}/editor" \
  --without-connection-token \
  --telemetry-level off
