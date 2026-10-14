# editor/Dockerfile — the VSCodium reh-web editor as a webapp (task/ws-editor,
# docs/editor-webapp.md + docs/editor-spike.md): self-hosted VS Code in the
# browser with server-side files. Thin on purpose — the pinned upstream
# tarball plus a user; everything else (auth, TLS, the base path, framing)
# is web-pi's same-origin /editor proxy in front of it.
#
# Runs as uid 2000 / gid 2001 (the workspace user, matching the web-pi
# image's split) so it edits the checkouts on the shared webpi-workspace
# volume at the same /workspace path the webpi + workspace containers use
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
# libstdc++6/libgcc-s1: the tarball's bundled node links against them
# (present in bookworm-slim via apt's own dependency, kept explicit so a
# slimmer base never breaks the binary at runtime).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libstdc++6 libgcc-s12 \
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

# uid 2000 / gid 2001 — the workspace user and the webpi shared group,
# matching the web-pi image's split; the webpi group lets this user read
# group-shared files on the workspace volume (umask 0007 keeps what it
# writes group-shared in turn — set in the entrypoint).
RUN groupadd -g 2001 webpi \
    && useradd -u 2000 -g 2001 -m -s /bin/bash workspace

COPY docker-editor-entrypoint.sh /usr/local/bin/docker-editor-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-editor-entrypoint.sh

EXPOSE 3000
USER workspace
ENV HOME=/home/workspace
ENTRYPOINT ["/usr/local/bin/docker-editor-entrypoint.sh"]
