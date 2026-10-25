#!/bin/sh
# Uninstall the plain-host cybermole install (the counterpart of
# deploy/install-host.sh): stops and removes the systemd unit if present,
# then `npm rm -g cybermole`.
#
#   default: the state dir is KEPT — the login db and sessions, the
#            runtime pi agent dir (credentials, session history) and job
#            run logs under it all stay; reinstalling picks them back up.
#   --purge: ALSO deletes the state dir. DESTRUCTIVE: the login credential,
#            every session, pi credentials and job logs are gone. This flag
#            is the consent.
#
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

command -v npm >/dev/null 2>&1 || die "npm not found on PATH"
[ "$(id -u)" -ne 0 ] || die "run as the user cybermole was installed for, not root"
NPM_PREFIX=$(npm prefix -g)
STATE_DIR=${CYBERMOLE_STATE_DIR:-"$HOME/.local/state/cybermole"}

# ---------- the systemd unit (root; best-effort without sudo) ----------

if [ -f /etc/systemd/system/cybermole.service ] || [ "$DRY_RUN" -eq 1 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    run sudo systemctl disable --now cybermole || true
    run sudo rm -f /etc/systemd/system/cybermole.service
    run sudo systemctl daemon-reload
    info "systemd unit removed"
  elif [ "$DRY_RUN" -eq 1 ]; then
    printf 'dry-run %% sudo systemctl disable --now cybermole (only if a unit is installed)\n'
  else
    info "the systemd unit is installed but passwordless sudo is unavailable — remove it by hand:"
    printf '  sudo systemctl disable --now cybermole && sudo rm /etc/systemd/system/cybermole.service && sudo systemctl daemon-reload\n'
  fi
fi

# ---------- the package ----------

if [ -x "$NPM_PREFIX/bin/cybermole" ]; then
  if [ -w "$NPM_PREFIX" ]; then
    run npm rm -g cybermole
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    run sudo npm rm -g cybermole
  else
    die "npm prefix $NPM_PREFIX is root-owned and passwordless sudo is unavailable — run: sudo npm rm -g cybermole"
  fi
else
  info "no cybermole under $NPM_PREFIX — skipping the npm removal"
fi

# ---------- state ----------

if [ "$PURGE" -eq 1 ]; then
  if [ -e "$STATE_DIR" ]; then
    run rm -rf "$STATE_DIR"
    info "purged state dir $STATE_DIR (login db, sessions, pi credentials, job logs)"
  else
    info "nothing at $STATE_DIR — already clean"
  fi
else
  info "state kept at $STATE_DIR — delete it yourself, or re-run with --purge"
fi
