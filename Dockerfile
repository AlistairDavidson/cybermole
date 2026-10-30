ARG NODE_VERSION=22

# ---------- build: install deps, compile ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
# The BUILD stage never runs playwright — the runtime stage installs the
# browser it ships (see the playwright install there), so the postinstall
# download here (~300MB of fetch per build) is skipped.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
# npm ci with workspaces links packages/* — the kit's manifest must be
# present for it (the source itself arrives with the COPY . . below).
COPY packages/app-kit/package.json packages/app-kit/package.json
RUN npm ci
COPY . .

ARG CYBERMOLE_BASE=/
RUN CYBERMOLE_BASE="${CYBERMOLE_BASE}" npm run build

# ---------- runtime base: app + user, NO compiler toolchain ----------
# Prod never compiles anything (node-pty arrives prebuilt in the seed copy);
# only the dev stage below needs build-essential/python3 for its npm install.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux git ripgrep ca-certificates zsh \
 && rm -rf /var/lib/apt/lists/*
# zsh (task/defaults-settings): the shipped compose default shell
# (CYBERMOLE_COMMAND=zsh -l on the cybermole + dev services). The binary
# must exist where tmux spawns sessions — the WORKSPACE container of the
# split runs this same image, so installing it here covers every target
# (the dev stage below FROMs runtime and inherits it).

# Privilege split (DESIGN_REVIEW §1.1), one image / two roles:
#   web       — uid node (base image): serves HTTP/WS from /opt/cybermole,
#               ROOT-owned below (no --chown) so it is immutable to the
#               app user; owns web state on /state; only a tmux CLIENT.
#   workspace — uid 2000 (user `workspace`): runs the tmux server and
#               every pi session (docker-workspace-entrypoint.sh).
# `cybermole` (fixed gid 2001) is the shared group: the socket dir is
# 2770/setgid cybermole, tmux's socket gets chmod 0660 + chgrp cybermole, and
# umask 0007 on the workspace side keeps pi's session files group-
# readable so the web sidebar can list them. Both users exist in BOTH
# containers (same image) — tmux's `server-access` admits by NAME.
RUN groupadd -g 2001 cybermole \
 && useradd -u 2000 -g cybermole -m -s /bin/bash workspace \
 && usermod -aG cybermole node

# /state is where compose points CYBERMOLE_STATE_DIR (cybermole.db — web-side
# state) — created node-owned here so a fresh named volume mounted on it
# inherits that ownership instead of the root:root an empty volume starts
# with.
RUN mkdir /state && chown node:node /state

# Root-owned app copy (immutable to the node user — the split's point;
# the old --chown=node:node made the server rewriteable by its own
# sessions). Workspace mounts/checkouts live on the cybermole-workspace
# volume instead. The entrypoints stay root-owned — exec needs only the
# mode bit — and the chmod guards contexts that drop mode bits.
COPY --from=build /repo /opt/cybermole
COPY deploy/docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deploy/docker/docker-workspace-entrypoint.sh /usr/local/bin/docker-workspace-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-workspace-entrypoint.sh

# In-container e2e: agents (and app trees) run `npm run test:e2e` from the
# workspace container, where `playwright install` is not an option — the
# browser download is fine but its system libs need apt, i.e. root the
# workspace uid does not have. So the image ships Playwright's chromium
# (full + headless shell, matching the lockfile's playwright version) with
# `--with-deps` at a shared read-only path; PLAYWRIGHT_BROWSERS_PATH points
# every process there (~450MB of image — the price of self-contained e2e).
# A user wanting another browser/engine at runtime overrides the env to a
# writable path and `playwright install`s into it (the baked set stays).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN cd /opt/cybermole && ./node_modules/.bin/playwright install --with-deps chromium

USER node
# /app stays the dev profile's bind target (WORKDIR auto-creates it); the
# web service runs from /opt/cybermole via compose `working_dir` — no volume
# shadows either copy anymore.
WORKDIR /app
EXPOSE 3000
ENV NODE_ENV=production
ENV CYBERMOLE_HOST=0.0.0.0

# Persist the build-time base as the runtime default, so plain `docker run`
# doesn't have to repeat it (compose env still wins).
ARG CYBERMOLE_BASE=/
ENV CYBERMOLE_BASE=${CYBERMOLE_BASE}

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.CYBERMOLE_PORT||'3000')+(process.env.CYBERMOLE_BASE||'/').replace(/\\/+$/,'')+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist-server/server/main.js"]

# ---------- dev: runtime + toolchain, for in-container npm install ----------
# Built with `--target dev` (compose's dev profile); the shadow node_modules
# volume compiles node-pty here.
FROM runtime AS dev
# runtime dropped to USER node above; apt needs root. (This was broken —
# plain `--target dev` builds inherited node and died in apt-get with
# "Permission denied". Compose overrides the user per-service anyway.)
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*
USER node

# ---------- prod: default (last) stage ----------
FROM runtime AS prod
