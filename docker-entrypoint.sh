#!/bin/sh
# web-pi web container entrypoint — the serving half of the privilege
# split (DESIGN_REVIEW §1.1). The app serves the image's own copy at
# /opt/web-pi — root-owned, immutable to the app user (uid node): the old
# /app named-volume + first-boot-seed / image-sync loop is gone on
# purpose. Updates are an image rebuild + `up -d` (README "Updating"); the
# workspace half (tmux server + pi sessions, uid 2000) boots via
# docker-workspace-entrypoint.sh instead of this file.
#
# Dev mode (compose dev profile) bind-mounts the host repo over /app and
# overrides this entrypoint entirely.
set -e

# Object storage keys (WEB_PI_S3_ACCESS_KEY / WEB_PI_S3_SECRET_KEY),
# generated once by compose's seaweedfs-init onto a volume mounted :ro
# here. Absent outside that stack (plain `docker run`): storage then
# stays unconfigured unless the env provides it.
if [ -r /run/web-pi-s3/credentials.env ]; then
  set -a
  . /run/web-pi-s3/credentials.env
  set +a
fi

# task/zed-webapp: the Zed launcher token, generated once by compose's
# zed-init (profile `zed`) onto its own volume mounted :ro here. Absent
# when the profile isn't deployed: the Zed feature then stays off.
if [ -r /run/web-pi-zed/zed.env ]; then
  set -a
  . /run/web-pi-zed/zed.env
  set +a
fi

cd /opt/web-pi
exec "$@"
