# deploy/editor/Dockerfile — the VSCodium reh-web editor as a webapp (task/ws-editor,
# docs/guides/editor-webapp.md + docs/plans/editor-spike.md): self-hosted VS Code in the
# browser with server-side files. Thin on purpose — the pinned upstream
# tarball plus a user; everything else (auth, TLS, the base path, framing)
# is cybermole's same-origin /editor proxy in front of it.
#
# Runs as uid 2000 / gid 2001 (the workspace user, matching the cybermole
# image's split) so it edits the checkouts on the shared cybermole-workspace
# volume at the same /workspace path the cybermole + workspace containers use
# (path agreement, like the tmux split). The server is the reh-web build's
# own entrypoint (bin/codium-server — `codium serve-web` is the desktop
# CLI's door to the same component; spike-verified), NOT started from a
# shell: no launcher container, no token file — folders open by URL.
FROM debian:bookworm-slim

ARG TARGETARCH
# VSCodium stable, pinned (the current stable release at spike time; sha256s
# recorded below, one per arch). x64/arm64 are the release asset arches;
# TARGETARCH is amd64/arm64 (the compose build passes the same pin).
ARG VSCODIUM_VERSION=1.140.06880
ARG VSCODIUM_SHA256_X64=f16388ea58170613c6d5e492aa10410a471e1d86d8cb343e3c8147493a7981a9
ARG VSCODIUM_SHA256_ARM64=d21cccd1f21f0960b0b4ecb366149a6883bd1c5c5ecd0b32d44e65a618096a9f

# ca-certificates: the server's own https fetches (Open VSX gallery).
# curl: the pinned tarball + extension downloads below (not in
# bookworm-slim).
# git: the workbench's built-in Git/SCM extension and the integrated
# terminal both shell out to it (VSCodium flags it missing otherwise) —
# checkouts are the editor's whole job.
# libstdc++6/libgcc-s1: the tarball's bundled node links against them
# (present in bookworm-slim via apt's own dependency, kept explicit so a
# slimmer base never breaks the binary at runtime).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git libstdc++6 libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*

# The pinned reh-web tarball, sha256-verified at build (the release ships a
# .sha256 sidecar asset — the values above). Extracted to /opt/editor so the
# tarball's layout (bin/, node, out/, extensions/, product.json) stays
# intact: bin/codium-server resolves its ROOT from its own path.
RUN case "$TARGETARCH" in \
      amd64) ASSET=x64;   SHA="$VSCODIUM_SHA256_X64"   ;; \
      arm64) ASSET=arm64; SHA="$VSCODIUM_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/codium.tar.gz \
      "https://github.com/VSCodium/vscodium/releases/download/${VSCODIUM_VERSION}/vscodium-reh-web-linux-${ASSET}-${VSCODIUM_VERSION}.tar.gz" \
    && echo "${SHA}  /tmp/codium.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/editor && tar -xzf /tmp/codium.tar.gz -C /opt/editor \
    && rm -f /tmp/codium.tar.gz \
    && /opt/editor/bin/codium-server --version

# Bundled extensions — the editor should know cybermole's stack out of the
# box: pinned Open VSX .vsixs, sha256-verified at build exactly like the
# tarball above, baked read-only at /opt/editor-bundled-extensions. The
# entrypoint installs them into the persistent home volume's extensions
# dir on first boot (offline — no gallery round-trip); Open VSX stays
# available in the workbench for anything else the user wants.
#
#   astro-build.astro-vscode  the stack's framework (the official Astro
#     extension). Platform-specific .vsix (the language server ships
#     per-OS bits): one sha256 per arch, selected below like the tarball.
#   ms-playwright.playwright the repo's e2e toolchain (tests/e2e).
#   redhat.vscode-yaml       compose.yaml / deploy configs — VS Code
#     bundles no YAML support of its own.
ARG ASTRO_EXT_VERSION=2.16.20
ARG ASTRO_EXT_SHA256_X64=5ca31435f5440daf79e0e3cc5e7ff07f099762a2d579268d2af82f066fd195d3
ARG ASTRO_EXT_SHA256_ARM64=472e3dc42682ff93651487428cb8937430c8a57b708c9ba18f84fb86df263fb0
ARG PLAYWRIGHT_EXT_VERSION=1.1.19
ARG PLAYWRIGHT_EXT_SHA256=23fa3d9a97596935a13ebc546172a262cfa16eb95f4c3ce0d81a4153ce7a50ce
ARG YAML_EXT_VERSION=2.0.2026101408
ARG YAML_EXT_SHA256=85496e5cd9255de4ba777e6f848a95a62466baa939556773b4570acb629ca9b9

RUN case "$TARGETARCH" in \
      amd64) ASSET=x64;   ASTRO_SHA="$ASTRO_EXT_SHA256_X64"   ;; \
      arm64) ASSET=arm64; ASTRO_SHA="$ASTRO_EXT_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && mkdir -p /opt/editor-bundled-extensions \
    && curl -fsSL -o /opt/editor-bundled-extensions/astro-build.astro-vscode.vsix \
      "https://open-vsx.org/api/astro-build/astro-vscode/linux-${ASSET}/${ASTRO_EXT_VERSION}/file/astro-build.astro-vscode-${ASTRO_EXT_VERSION}@linux-${ASSET}.vsix" \
    && echo "${ASTRO_SHA}  /opt/editor-bundled-extensions/astro-build.astro-vscode.vsix" | sha256sum -c - \
    && curl -fsSL -o /opt/editor-bundled-extensions/ms-playwright.playwright.vsix \
      "https://open-vsx.org/api/ms-playwright/playwright/${PLAYWRIGHT_EXT_VERSION}/file/ms-playwright.playwright-${PLAYWRIGHT_EXT_VERSION}.vsix" \
    && echo "${PLAYWRIGHT_EXT_SHA256}  /opt/editor-bundled-extensions/ms-playwright.playwright.vsix" | sha256sum -c - \
    && curl -fsSL -o /opt/editor-bundled-extensions/redhat.vscode-yaml.vsix \
      "https://open-vsx.org/api/redhat/vscode-yaml/${YAML_EXT_VERSION}/file/redhat.vscode-yaml-${YAML_EXT_VERSION}.vsix" \
    && echo "${YAML_EXT_SHA256}  /opt/editor-bundled-extensions/redhat.vscode-yaml.vsix" | sha256sum -c -

# uid 2000 / gid 2001 — the workspace user and the cybermole shared group,
# matching the cybermole image's split; the cybermole group lets this user read
# group-shared files on the workspace volume (umask 0007 keeps what it
# writes group-shared in turn — set in the entrypoint).
RUN groupadd -g 2001 cybermole \
    && useradd -u 2000 -g 2001 -m -s /bin/bash workspace

COPY docker-editor-entrypoint.sh /usr/local/bin/docker-editor-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-editor-entrypoint.sh

EXPOSE 3000
USER workspace
ENV HOME=/home/workspace
ENTRYPOINT ["/usr/local/bin/docker-editor-entrypoint.sh"]
