#!/bin/sh
# Install cybermole from this checkout with Docker compose — the
# recommended shape (README "Deploying"): builds the image, boots the
# stack (web + workspace + editor + seaweedfs + the one-shot inits) on
# loopback 127.0.0.1:3000, then verifies it serves /login. Idempotent:
# re-running is a rebuild (cached) + `up -d` (a no-op when already up) +
# the same verification. The login password is deliberately NOT set here
# (it is a secret — run the set-password step from
# docs/guides/installation.md yourself).
#
# Preflight is the point, not ceremony: every check that fails prints
# what failed and the fix, so a human or an agent can run this verbatim
# and knows the divergence. --dry-run runs the checks and prints every
# mutation instead of performing it.
#
# Flags:
#   --dry-run            print each mutation, change nothing
#   --with-shell-config  after `up`, stage this user's zsh dotfiles
#                        (~/.zshenv, ~/.zprofile, ~/.zshrc, ~/.zlogin —
#                        those that exist) into the workspace container's
#                        persistent staging dir (/workspace/.cybermole/
#                        shell) and recreate that container, so its fresh
#                        home is seeded from the staged copies. Opt-in and
#                        non-destructive: host files are never modified, a
#                        config already in the container's $HOME always
#                        wins. Recreating the workspace service ends live
#                        terminal sessions — a fresh install has none. See
#                        docs/guides/installation.md ("Shell settings").
#
# Network: nothing beyond the documented fetches (docs/guides/
# installation.md) — docker registry pulls for the base images and, inside
# the image build, Debian apt + `npm ci` against the lockfile.
set -eu
# pipefail where the shell has it (POSIX sh does not promise it)
# shellcheck disable=SC3040
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

DRY_RUN=0
WITH_SHELL_CONFIG=0

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
    --with-shell-config) WITH_SHELL_CONFIG=1 ;;
    -h | --help) usage 0 ;;
    *) printf 'unknown flag: %s\n\n' "$arg" >&2; usage 1 >&2 ;;
  esac
done

# Run a mutation: argv-only (no shell metacharacters).
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'dry-run %% %s\n' "$*"
  else
    "$@"
  fi
}

# ---------- preflight ----------

command -v docker >/dev/null 2>&1 || die "docker not found on PATH — install Docker Engine (docs.docker.com/engine/install/)"
docker info >/dev/null 2>&1 || die "docker daemon not reachable — is it running, and is this user in the docker group? (sudo usermod -aG docker $USER, then re-login)"
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing — install the compose plugin (docs.docker.com/compose/install/)"
[ -f compose.yaml ] || die "compose.yaml not found in $(pwd) — run this from the cybermole checkout: sh deploy/install-compose.sh"

BASE_PATH=${CYBERMOLE_BASE:-/}
[ "$BASE_PATH" = / ] || warn "CYBERMOLE_BASE=$BASE_PATH — subpath deploy: the image bakes the base at build time; see README 'The base path' before continuing"
PROBE_URL="http://127.0.0.1:3000${BASE_PATH%/}/login"

port_listens() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null --max-time 2 "$PROBE_URL"
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 3000
  else
    warn "neither curl nor nc found — cannot pre-check port 3000; docker fails loudly if it is taken"
    return 1
  fi
}
if port_listens; then
  if [ -n "$(docker compose ps -q --status running 2>/dev/null)" ]; then
    info "port 3000 answers and this stack's containers are running — treating this as a re-run (up -d will no-op)"
  else
    die "something other than this stack is listening on 127.0.0.1:3000 — stop it, or remap the publish in compose.yaml"
  fi
fi

avail_mb=$(df -Pm . | awk 'NR==2 {print $4}')
[ "${avail_mb:-0}" -ge 4096 ] || warn "only ${avail_mb:-?} MiB free here — the image build wants a few GiB (apt + npm in-layer)"

info "preflight ok: docker $(docker --version | cut -d, -f1), $(docker compose version --short), probe $PROBE_URL"

# ---------- install ----------

run docker compose build
run docker compose up -d

if [ "$DRY_RUN" -eq 0 ]; then
  info "waiting for the web container to serve ${BASE_PATH%/}/login (first boot builds+boots; ~30-90s)"
  i=1
  while [ "$i" -le 90 ]; do
    if docker compose exec -T cybermole node -e \
      "fetch('$PROBE_URL').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
      >/dev/null 2>&1; then
      info "serving $PROBE_URL"
      break
    fi
    [ "$i" -eq 90 ] && die "not serving /login after 90s — 'docker compose logs cybermole' says why"
    i=$((i + 1))
    sleep 1
  done
else
  printf 'dry-run %% wait for %s, then report readiness\n' "$PROBE_URL"
fi

# ---------- optional: stage the operator's zsh config ----------

if [ "$WITH_SHELL_CONFIG" -eq 1 ]; then
  staged=
  for f in .zshenv .zprofile .zshrc .zlogin; do
    [ -f "$HOME/$f" ] && staged="$staged $f"
  done
  if [ -n "$staged" ]; then
    run docker compose exec -T workspace mkdir -p /workspace/.cybermole/shell
    for f in $staged; do
      run docker compose cp "$HOME/$f" "workspace:/workspace/.cybermole/shell/$f"
      # compose cp preserves the source mode — a 0600 host dotfile would
      # land unreadable for the terminal uid (2000); normalize. Root in the
      # container, because the copy's owner may not be uid 2000.
      run docker compose exec -T -u 0 workspace chmod 0644 "/workspace/.cybermole/shell/$f"
    done
    # A plain restart keeps the container's writable layer — where the
    # DEFAULT .zshrc seeded on the `up` above already sits — and the seed
    # is only-where-absent, so applying the staged copies needs a fresh
    # $HOME. Recreating ends live terminal sessions (none on a fresh
    # install) and discards in-$HOME edits, never the staged files or
    # anything under /workspace.
    run docker compose up -d --force-recreate workspace
    info "staged zsh config from $HOME:$staged — seeded into the terminal user's fresh home (only where absent; docs/guides/installation.md explains re-applying after edits)"
  else
    warn "--with-shell-config: no zsh dotfiles (~/.zshenv, ~/.zprofile, ~/.zshrc, ~/.zlogin) in $HOME — nothing staged; the image default applies"
  fi
fi

# ---------- what's next (the guide has the full steps) ----------

cat <<EOF

cybermole is up on $PROBE_URL (loopback — front it with TLS before
exposing it anywhere; deploy/nginx/ has the reverse-proxy block).

Next, set the login password (interactive — or pipe it, see the guide):

  docker compose exec cybermole node dist-server/server/set-password.js

Shell settings: terminals run zsh as uid 2000 in the workspace container
with a minimal default config. To seed them from THIS user's zsh dotfiles
instead, re-run: sh deploy/install-compose.sh --with-shell-config

Full install/update/uninstall story: docs/guides/installation.md
EOF
