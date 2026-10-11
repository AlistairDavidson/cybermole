# zed/Dockerfile — the Zed editor as a webapp: Zed (GPU-accelerated by
# design) rendered headlessly through Mesa's CPU Vulkan driver (lavapipe)
# into KasmVNC's X server, which streams the desktop to the browser with
# its built-in web client. Research, decisions and host-side verification:
# docs/zed-webapp.md.
#
# Runs as uid 2000 (the workspace user) so it can edit the checkouts on
# the shared webpi-workspace volume, at the same path (/workspace) the
# webpi + workspace containers use. Zed itself is NOT started at boot:
# the first folder-open request boots it (the zed CLI spawns the editor
# when its socket is absent — see zed-launcher.py).
FROM debian:bookworm-slim

ARG TARGETARCH
# Zed stable, pinned (recorded in docs/zed-webapp.md). x86_64/aarch64 are
# the release asset arches; TARGETARCH is amd64/arm64.
ARG ZED_VERSION=v1.23.2
ARG KASMVNC_VERSION=1.5.0

# libvulkan1 + mesa-vulkan-drivers = lavapipe, the CPU Vulkan ICD — Zed's
# wgpu renderer accepts a software adapter for surface creation (its
# "reject software" path is only the device-recovery retry), logging
# `Using GPU: is_software_emulated: true, "llvmpipe"` and continuing.
# fontconfig + a font: cosmic-text needs system fonts. libasound2 /
# libxkbcommon(-x11): Zed's other dlopens. openbox: a WM that follows
# KasmVNC's RandR resizes (dynamic resolution). python3: the launcher.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl fontconfig fonts-dejavu-core libasound2 \
      libvulkan1 libxkbcommon-x11-0 libxkbcommon0 mesa-vulkan-drivers \
      openbox python3 \
    && rm -rf /var/lib/apt/lists/*

# KasmVNC — web-native VNC server: serves its own browser client on the
# websocket port, handles clipboard sync, dynamic resolution and basic
# auth (.kasmpasswd). Pinned release deb.
RUN case "$TARGETARCH" in \
      amd64) KASM_ARCH=amd64; ZED_ARCH=x86_64 ;; \
      arm64) KASM_ARCH=arm64; ZED_ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/kasmvnc.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_${KASM_ARCH}.deb" \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb && rm -rf /var/lib/apt/lists/*

# Zed, pinned to a release tag (glibc >= 2.31 — bookworm's 2.36 is fine).
# The CLI finds the editor binary at ../libexec/zed-editor relative to
# its own (canonicalized) path, so the tarball layout must stay intact.
RUN case "$TARGETARCH" in \
      amd64) ZED_ARCH=x86_64 ;; \
      arm64) ZED_ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/zed.tar.gz \
      "https://github.com/zed-industries/zed/releases/download/${ZED_VERSION}/zed-linux-${ZED_ARCH}.tar.gz" \
    && mkdir -p /opt/zed && tar -xzf /tmp/zed.tar.gz -C /opt/zed \
    && rm -f /tmp/zed.tar.gz \
    && ln -s /opt/zed/zed.app/bin/zed /usr/local/bin/zed \
    && /usr/local/bin/zed --version
ENV ZED_VERSION=${ZED_VERSION}

# uid 2000 / gid 2001 — the workspace user and the webpi shared group,
# matching the web-pi image's split (README "The privilege split").
# webpi group membership lets this user read the launcher token
# zed-init generates (gid 2001 is what the web container reads it with).
# ssl-cert: the KasmVNC deb's default snake-oil certificate group.
RUN groupadd -g 2001 webpi \
    && useradd -u 2000 -g 2001 -m -s /bin/sh workspace \
    && usermod -a -G ssl-cert workspace

# Server-level KasmVNC config (sparse: unlisted keys keep the deb's
# defaults). require_ssl false: TLS terminates at the reverse proxy
# (deploy/nginx-zed.conf), this listener is loopback-published only.
# Dynamic resolution on: the client resize drives RandR (openbox follows).
# Clipboard on both directions — an editor without paste is not an editor.
# Prompt off: headless boot, the entrypoint seeds user + xstartup itself.
COPY kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml
COPY zed-launcher.py /opt/zed/zed-launcher.py
COPY docker-zed-entrypoint.sh /usr/local/bin/docker-zed-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-zed-entrypoint.sh

EXPOSE 6901
USER workspace
ENV HOME=/home/workspace
ENTRYPOINT ["/usr/local/bin/docker-zed-entrypoint.sh"]
