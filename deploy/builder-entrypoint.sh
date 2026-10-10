#!/bin/sh
# web-pi builder entrypoint — the management page's build half
# (docs/management-page.md §2). Runs as user `builder` (uid 2010) from the
# DEV image target (toolchain present), sharing two volumes with web:
#   /workspace  the sessions' tree, READ-ONLY here — the git checkout
#               web's management page reads; readable via the webpi group.
#   /releases   the shared protocol volume (group `releases`: web + this
#               container, NEVER the sessions' uid 2000 — that separation
#               is what makes a release dir builder-authored rather than
#               session-forged; see docs §2 and activate's validation).
#
# The contract (src/schemas/management.ts is the other half):
#   web writes   /releases/pending/<sha>.json   {sha, base, requestedAt}
#   builder      moves it to building/, builds, answers
#                /releases/done/<sha>.json      {sha, status, builtAt, log}
#                and the release at /releases/<sha>/
#                  dist/            (Astro client + SSR handler — the
#                                   release deliberately ships NO
#                                   dist-server: the gate stays image-
#                                   resident, docs §3.1)
#                  manifest.json    {sha, builtAt, builder}
#
# Build rules that make the release trustworthy-enough (docs §1.4–1.5):
#   - the tree is materialized from the CONTENT-ADDRESSED sha
#     (git archive <sha>), never the mutable working tree;
#   - node_modules is the IMAGE's own (root-owned, built at image build
#     from the lockfile) — the protected lockfile pins it equal, so no
#     npm install, no network, no lifecycle scripts from the tree run;
#   - the build executes only the pinned `build` script (protected
#     package.json) with the image's toolchain; nothing is fetched
#     (compose gives this container no network at all);
#   - everything lands under /releases; a failure answers a failed done
#     marker and cleans up.
#
# Scaffolded for a docker host (this sandbox has none); the web side of
# the protocol (marker writes, status reads, release validation, the
# pointer + activate swap) is implemented and unit-tested in
# src/lib/releases.ts. Host verification: docs/management-page.md §7.
set -u

RELEASES=${WEB_PI_RELEASES_DIR:-/releases}
CHECKOUT=${WEB_PI_MANAGEMENT_CHECKOUT:-/workspace/web-pi}
IMAGE_ROOT=/opt/web-pi
LOG_CAP=16384
POLL_SECS=5
# Everything this container writes must stay group-readable (group
# `releases`) so web can read markers and serve release dirs; the setgid
# volume dirs keep the group even for subdirs.
umask 0007

log() { echo "web-pi builder: $*"; }

# git hardening: the checkout is owned by ANOTHER uid (safe.directory) and
# its .git/config is attacker-writable (sessions own the checkout) — so
# ambient config is disabled and hooks are pinned off; every call carries
# its own -c flags. git archive reads the object db only — no hooks, no
# working-tree filters, no network.
GIT="git -c safe.directory=* -c core.hooksPath=/dev/null --no-pager"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# The log's tail as one JSON string (capped, quotes escaped).
log_tail() { tail -c "$LOG_CAP" "$1" 2>/dev/null | tr -d '\r' | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }

finish() {
  # $1 = sha, $2 = status (built|failed), $3 = log text (already escaped)
  printf '{"sha":"%s","status":"%s","builtAt":%s,"log":"%s"}\n' \
    "$1" "$2" "$(date +%s000)" "$3" > "$RELEASES/done/$1.json.tmp"
  mv "$RELEASES/done/$1.json.tmp" "$RELEASES/done/$1.json"
}

build_one() {
  # $1 = the claimed building/<sha>.json marker
  marker=$1
  sha=${marker##*/}; sha=${sha%.json}
  echo "$sha" | grep -Eq '^[0-9a-f]{40}$' || { log "dropping malformed marker $marker"; rm -f "$marker"; return 0; }
  work="$RELEASES/.work-$sha"
  logf="$RELEASES/.work-$sha.log"
  rm -rf "$work" "$logf"
  mkdir -p "$work/tree" "$RELEASES/done" || return 1

  # 1. materialize the content-addressed tree (never the working tree)
  if ! $GIT -C "$CHECKOUT" archive "$sha" | tar -x -C "$work/tree" >> "$logf" 2>&1; then
    finish "$sha" failed "could not archive $sha from $CHECKOUT — $(log_tail "$logf")"
    rm -rf "$work" "$logf" "$marker"; return 0
  fi

  # 2. the image's node_modules: same lockfile (protected ⇒ identical
  #    deps), node-pty prebuilt — no npm install, no scripts, no network.
  if ! cp -a "$IMAGE_ROOT/node_modules" "$work/tree/node_modules" >> "$logf" 2>&1; then
    finish "$sha" failed "could not copy the image node_modules"
    rm -rf "$work" "$logf" "$marker"; return 0
  fi

  # 3. build with the pinned script (protected package.json). The
  #    environment carries no credentials; nothing is fetched.
  if ! (cd "$work/tree" && NODE_ENV=production ASTRO_TELEMETRY_DISABLED=1 \
      node "$IMAGE_ROOT/node_modules/npm/bin/npm-cli.js" run build) >> "$logf" 2>&1; then
    finish "$sha" failed "npm run build exited non-zero — $(log_tail "$logf")"
    rm -rf "$work" "$logf" "$marker"; return 0
  fi
  if [ ! -f "$work/tree/dist/server/entry.mjs" ]; then
    finish "$sha" failed "dist/server/entry.mjs missing after build"
    rm -rf "$work" "$logf" "$marker"; return 0
  fi

  # 4. lay out the release atomically (tmp dir + rename): web either sees
  #    no release or a complete one, never a half-written one.
  rel="$work/release"
  mkdir -p "$rel"
  cp -a "$work/tree/dist" "$rel/dist"
  printf '{"sha":"%s","builtAt":%s,"builder":"web-pi dev image"}\n' \
    "$sha" "$(date +%s000)" > "$rel/manifest.json"
  if ! mv "$rel" "$RELEASES/$sha"; then
    finish "$sha" failed "could not move the release into place"
    rm -rf "$work" "$logf" "$marker"; return 0
  fi

  # 5. answer the done marker (atomic too), then clean up.
  finish "$sha" built "$(log_tail "$logf")"
  rm -rf "$work" "$logf" "$marker"
  log "built $sha"
}

log "watching $RELEASES/pending (checkout $CHECKOUT)"
while true; do
  for request in "$RELEASES"/pending/*.json; do
    [ -f "$request" ] || continue
    # claim by rename — only one builder instance can win the move.
    sha=${request##*/}; sha=${sha%.json}
    if mv "$request" "$RELEASES/building/$sha.json" 2>/dev/null; then
      build_one "$RELEASES/building/$sha.json" || rm -f "$request"
    fi
  done
  sleep "$POLL_SECS"
done
