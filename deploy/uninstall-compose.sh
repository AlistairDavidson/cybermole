#!/bin/sh
# Uninstall the cybermole compose stack — run it from the cybermole
# checkout (where compose.yaml lives), like install-compose.sh.
#
#   default: `docker compose down` — stops and removes the containers and
#            the compose network. NOTHING is deleted: the state volume
#            (login + jobs db), the workspace volume (every file your
#            terminals created), uploads and their credentials all stay,
#            and `docker compose up -d` brings the same instance back.
#   --purge: ALSO deletes the named volumes and the locally built images.
#            DESTRUCTIVE and irreversible: the login db and sessions, the
#            whole workspace tree (checkouts, pi credentials, shell
#            history), uploads, and the Loki store all go. This flag is
#            the consent.
#
# The checkout itself is never touched — remove it yourself if you want.
# --dry-run prints what would run.
set -eu
# pipefail where the shell has it (POSIX sh does not promise it)
# shellcheck disable=SC3040
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

DRY_RUN=0
PURGE=0

info() { printf 'cybermole-uninstall: %s\n' "$*"; }
die() { printf 'cybermole-uninstall: ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --purge) PURGE=1 ;;
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

command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing"
[ -f compose.yaml ] || die "compose.yaml not found in $(pwd) — run from the cybermole checkout: sh deploy/uninstall-compose.sh"

if [ "$PURGE" -eq 1 ]; then
  info "--purge: deleting the volumes (cybermole-state: login+sessions+jobs db; cybermole-workspace: EVERY file the terminals created, pi credentials, zsh history; cybermole-seaweedfs + cybermole-s3-credentials: uploads; cybermole-loki: stored logs) and the built images"
  run docker compose down --volumes
  run docker rmi "${CYBERMOLE_IMAGE:-cybermole:local}" || info "(image ${CYBERMOLE_IMAGE:-cybermole:local} not present — skipped)"
  run docker rmi cybermole-editor:local || info "(image cybermole-editor:local not present — skipped)"
  info "purged — the checkout itself is still here (delete it yourself if you want)"
else
  run docker compose down
  info "stack down, state kept: 'docker compose up -d' in this checkout brings the same instance back"
  info "to delete state too (destructive): sh deploy/uninstall-compose.sh --purge"
fi
