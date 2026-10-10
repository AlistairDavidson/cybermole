ARG NODE_VERSION=22

# ---------- build: install deps, compile ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
# The image never runs playwright (e2e lives on the host, AGENTS.md) — skip
# its postinstall browser download (~300MB of fetch per build).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# task/mgmt-page (docs/management-page.md §1.2): record the source commit
# the image was built from — the TRUSTED root of the management page's
# enforcement base chain. Passed by the host/CI:
#   GIT_SHA=$(git rev-parse HEAD) docker compose build
# An 'unknown' sha is honest (records as such) but leaves the management
# page refusing applies until the image is rebuilt with the sha recorded.
ARG GIT_SHA=unknown
RUN printf '{"git":"%s","builtAt":"%s"}\n' "$GIT_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > version.json

ARG WEB_PI_BASE=/
RUN WEB_PI_BASE="${WEB_PI_BASE}" npm run build

# ---------- runtime base: app + user, NO compiler toolchain ----------
# Prod never compiles anything (node-pty arrives prebuilt in the seed copy);
# only the dev stage below needs build-essential/python3 for its npm install.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Privilege split (DESIGN_REVIEW §1.1), one image / two roles:
#   web       — uid node (base image): serves HTTP/WS from /opt/web-pi,
#               ROOT-owned below (no --chown) so it is immutable to the
#               app user; owns web state on /state; only a tmux CLIENT.
#   workspace — uid 2000 (user `workspace`): runs the tmux server and
#               every pi session (docker-workspace-entrypoint.sh).
#   builder   — uid 2010 (user `builder`), dev-target image only: builds
#               releases for the management page (deploy/builder-entrypoint.sh).
#               Reads /workspace (via the webpi group) and writes the
#               releases volume (via the `releases` group) — deliberately
#               NOT uid 2000: pi sessions share that uid and could
#               otherwise forge release dirs / done markers, which
#               activate validates and web serves (docs §2).
# `webpi` (fixed gid 2001) is the shared group: the socket dir is
# 2770/setgid webpi, tmux's socket gets chmod 0660 + chgrp webpi, and
# umask 0007 on the workspace side keeps pi's session files group-
# readable so the web sidebar can list them. Both users exist in BOTH
# containers (same image) — tmux's `server-access` admits by NAME.
# `releases` (fixed gid 2011) is the web↔builder-only group: node and
# builder are members, workspace is NOT — that is what makes the releases
# volume's contents builder-authored rather than session-forged.
RUN groupadd -g 2001 webpi \
 && useradd -u 2000 -g webpi -m -s /bin/bash workspace \
 && groupadd -g 2011 releases \
 && useradd -u 2010 -g webpi -G releases -m -s /bin/bash builder \
 && usermod -aG webpi node \
 && usermod -aG releases node

# /state is where compose points WEB_PI_STATE_DIR (webpi.db — web-side
# state) — created node-owned here so a fresh named volume mounted on it
# inherits that ownership instead of the root:root an empty volume starts
# with.
RUN mkdir /state && chown node:node /state

# Root-owned app copy (immutable to the node user — the split's point;
# the old --chown=node:node made the server rewriteable by its own
# sessions). Workspace mounts/checkouts live on the webpi-workspace
# volume instead. The entrypoints stay root-owned — exec needs only the
# mode bit — and the chmod guards contexts that drop mode bits.
COPY --from=build /repo /opt/web-pi
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker-workspace-entrypoint.sh /usr/local/bin/docker-workspace-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-workspace-entrypoint.sh

USER node
# /app stays the dev profile's bind target (WORKDIR auto-creates it); the
# web service runs from /opt/web-pi via compose `working_dir` — no volume
# shadows either copy anymore.
WORKDIR /app
EXPOSE 3000
ENV NODE_ENV=production
ENV WEB_PI_HOST=0.0.0.0

# Persist the build-time base as the runtime default, so plain `docker run`
# doesn't have to repeat it (compose env still wins).
ARG WEB_PI_BASE=/
ENV WEB_PI_BASE=${WEB_PI_BASE}

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WEB_PI_PORT||'3000')+(process.env.WEB_PI_BASE||'/').replace(/\\/+$/,'')+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist-server/server/main.js"]

# ---------- dev: runtime + toolchain, for in-container npm install ----------
# Built with `--target dev` (compose's dev profile); the shadow node_modules
# volume compiles node-pty here. Also the BUILDER image target (the
# management page's release builds run here — toolchain present).
FROM runtime AS dev
# runtime dropped to USER node above; apt needs root. (This was broken —
# plain `--target dev` builds inherited node and died in apt-get with
# "Permission denied". Compose overrides the user per-service anyway.)
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/builder-entrypoint.sh /usr/local/bin/builder-entrypoint.sh
RUN chmod 0755 /usr/local/bin/builder-entrypoint.sh
USER node

# ---------- prod: default (last) stage ----------
FROM runtime AS prod
