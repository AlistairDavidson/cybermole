# The management page — apply, rollback, and the one unmodifiable part

Design for TODO's "Management page": *rollback AND applying changes in one
place*, where *the one unmodifiable part of the software* is enforced
programmatically — the apply step rejects any patch that changes it from
within the container; it can only be modified in the original project on
the host.

Written before the endpoints (per the task brief). Sections 1–3 are the
decisions; §7 says exactly what is implemented vs scaffolded and how to
verify the scaffolded parts on the host.

---

## 0. Threat model recap (DESIGN_REVIEW §1.1)

A pi session is an arbitrary shell as uid 2000 in the workspace container.
It reads untrusted input, so a prompt injection must be assumed able to run
anything the workspace user can. The split (already landed) means it can:

- **not** write what the web container serves (`/opt/web-pi` is root-owned,
  the image copy) or its state (`/state` is mounted only in webpi),
- **not** reach the object-storage network,
- **but** write everything on `/workspace` — including a git checkout of
  web-pi and its history (branches, tags, `git commit --amend`, new
  objects, rewritten refs: all fair game).

The management page lets the *human* pick a commit from that
attacker-writable checkout, build it, and swap it in as what web serves.
The design question is: what can the page promise about that flow, and
what is structurally impossible to promise?

## 1. Enforcement — the protected set

### 1.1 What "apply" must never do

Apply must never let a patch authored *inside the container* change the
things that make the protection itself enforceable. Concretely, a commit
may not be applied when it changes:

| Protected path | Why |
| --- | --- |
| `compose.yaml` | The split's definition: which uid runs what, which mounts are `:ro`, which networks are `internal`, the restart policy the self-restart relies on, and (once added) the builder service itself. A weakened compose re-opens the boundary at the next host-side `up -d` built from this tree. |
| `Dockerfile` | Image construction: the root-owned `COPY --from=build /repo /opt/web-pi`, uid 2000 / gid 2001, entrypoints, the toolchain split between the `runtime` and `dev` targets, the baked version file. |
| `docker-entrypoint.sh` | The web container's entrypoint (credential loading, serve dir). |
| `docker-workspace-entrypoint.sh` | The workspace entrypoint: tmux server ownership, `server-access` admission of the web user, `umask 0007`, socket chmod/chgrp — the mechanics of the split itself. |
| `deploy/` | The perimeter: nginx (TLS, WS upgrade, the proxy hop `WEB_PI_TRUST_PROXY` is configured against) and fail2ban. |
| `.gitmodules` | Names external sources of code that enter the tree at checkout time (`git clone --recurse-submodules` on the host would fetch them). |
| `package.json` | Build inputs and dependency declarations: the `build` script is what the builder runs, and dependencies are the classic way new code (incl. native) enters a build. |
| `package-lock.json` | Pins every dependency and their install scripts; the builder's "reuse the image's `node_modules`" optimization (§2) is only sound while the lockfile is pinned to the image's. |
| `astro.config.mjs` | Executed as code at build time (Astro loads it), and defines the adapter, `bodySizeLimit`, and the `security.checkOrigin` hand-off to main.ts. |
| `tsconfig.json`, `tsconfig.server.json` | What the build compiles (the server build's `include`). |
| `server/main.ts` | **The gate**: origin check, session check, body caps, security headers, static-asset traversal checks, login/logout, the WS bridge. Everything else's guarantees hang off it. |
| `server/set-password.ts` | Credential machinery (the `setCredential` CLI). |
| `src/middleware.ts` | The fail-closed guard for `/api/*` and `/partials/*` without locals. |
| `src/lib/auth.ts` | Login verification, the persisted session store, `setCredential`. Backdooring this is backdooring the login. |
| `src/lib/env-schema.ts` | The `WEB_PI_*` contract (names, types, static defaults) — shared by Astro and the server. |
| `src/lib/env.ts` | The runtime reader of that contract: which socket, which paths, which storage endpoints are trusted, and the boot-time validation that stops the server on a bad config. |
| `src/lib/services.ts` | The capability broker: the object server/main.ts hands the Astro side. Its shape defines what release code may call. |
| `src/lib/releases.ts` | This module: the protected set, the enforcement, the marker protocol, the swap. Self-protecting by necessity — an apply must not be able to change the apply rules. |
| `src/schemas/api.ts` | The login wire schema (`loginBody`). |
| `src/pages/api/management/` | The routes that drive apply. The enforcement lives in the lib, but these routes are what call it — a patch must not be able to skip the call. |

Deliberately **not** protected (documented boundary):

- Application code — pages, components, the rest of `src/lib`
  (`jobs.ts`, `sessions.ts`, `storage.ts`, …). Changing them is the point
  of apply. Server-side lib changes are inert in a release (the running
  process keeps executing the image's copies; see §3.1) and only take
  effect at the next image deploy — by which time the human has rebuilt
  from this tree deliberately.
- `src/pages/management.astro` and `src/components/Management/` — the page
  could *lie* ("this commit is clean ✓") but cannot bypass anything: every
  dangerous verb re-runs the enforcement server-side in protected code.
  A lying page is caught by the apply response itself.
- Look-alike paths (`deploy2/`, `Dockerfile.old`, `src/lib/release.ts`):
  not load-bearing; nothing reads them.

### 1.2 The base — what the diff is computed against

Enforcement = `git diff <base>..<target>` must touch no protected path.
Both ends matter:

- **The target** is the commit the human picked — attacker-chosen by
  definition; that is fine, the diff judges it.
- **The base** must be *what is actually running*. The chain of trust:

  1. A fresh deploy serves the image copy. The image records its source
     commit in a root-owned `version.json` (`{"git": "<sha>", "builtAt":
     "<iso>"}`, baked by the Dockerfile from `ARG GIT_SHA` — set by the
     host: `GIT_SHA=$(git rev-parse HEAD) docker compose build`). A
     session cannot write it.
  2. After an apply, the running release's sha is recorded by the server's
     own protected code in a **pointer file** (`<releases>/pointer/current`,
     sha as its whole content) in a **web-only** subdir (0750 `node:node`)
     of the releases volume — not the state db: it is resolved at main.ts
     boot, before any db use, and the db's lazy open must stay lazy
     (db.ts); not the group-writable volume root either (the builder
     shares a group with web there — the pointer is the one thing ONLY
     web may write, which is what makes it a trustworthy diff base). Also
     unwritable by sessions.
  3. The base sha is resolved in the checkout with `git cat-file -e
     <sha>^{commit}`. Git objects are content-addressed: if the sha
     resolves, its tree is the tree that was built (short of a SHA-1
     collision — see §1.5). If it does **not** resolve — history was
     rewritten, or the checkout is a different repo — every apply is
     refused (`base_not_in_checkout`). Fail closed.
  4. `version.json` missing or `git: "unknown"` (image built without the
     ARG) → `base_unknown`: applies and previews refuse until the operator
     rebuilds the image with the sha recorded. Enforcement without a
     trustworthy base is theater, so it answers an error instead of
     pretending.

### 1.3 The diff mechanics (think like the attacker)

- `git -c safe.directory='*' --no-pager diff --no-renames --name-status
  -z <base> <target>`, run by the web container (uid node) against the
  `:ro` workspace mount. `safe.directory='*'` per-invocation is required:
  git refuses "dubious ownership" when the repo's owner (uid 2000) is not
  the caller — it must be a `-c` flag, never a config write (there is
  nowhere web may write, and a global config write would be state).
  Ambient config influence is blocked with
  `GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1` in the child env.
- `--no-renames`: every rename/copy surfaces as delete+add of both ends,
  so "rename into a protected path" (add `deploy/foo`) and "rename a
  protected path away" (delete `compose.yaml`) are each caught by their
  own side of the pair, with no rename-detection heuristics to fool.
- `-z`: NUL-separated records, paths verbatim — a path containing spaces,
  newlines, quotes, or leading `-` cannot smuggle past the parser (and
  execFile's argv array means no shell ever sees them).
- Status letters understood: `A`/`D`/`M`/`T` (one path each; `T` = type
  change — file↔symlink↔submodule — counts as a change at that path).
  With `--no-renames`, `R*`/`C*` never appear; the parser accepts them
  anyway (two paths, both judged) rather than trusting that. **Any other
  status letter fails closed** as a git/parse error — apply refuses, and
  the message names the record.
- Mode-only changes (chmod +x on an entrypoint) come out as `M`. Covered.
- Path normalization before matching: reject the empty string, absolute
  paths (`/…`), any `..` segment, and backslashes (a `\` is not a
  separator on Linux, and a path smuggling one is not one git minted).
  Then strip a leading `./` and collapse duplicate `/`. Matching is
  **case-sensitive and exact** (a protected file or `<dir>/…` under it):
  the container filesystems are case-sensitive, git paths are exact, and a
  case-folded match could only ever *widen* the match (false positives),
  never close the case-variant rename — which `--no-renames` already
  catches as D+A on the protected path.
- Symlinks: a symlink *at* a protected path is a type change (`T`) —
  rejected. A symlink elsewhere is just a file in the tree; the builder
  materializes the tree with `git archive` (symlinks stay symlinks,
  nothing is followed out of the tree), and the build runs where symlinks
  cannot reach anything privileged (§2).

Every one of these has a unit test written from the attacker's side
(`tests/unit/enforcement.test.mjs`): real `git init` fixtures, real
renames, chmods, symlink swaps, `\n`-in-filename adds, case variants,
look-alike paths, rewritten history.

### 1.4 What the enforcement promises — and what it cannot

The check guarantees: *the tree at `target` differs from the tree at
`base` only outside the protected set.* It runs in server-side code the
sessions cannot modify (`src/lib/releases.ts` + routes under
`src/pages/api/management/`, all protected paths themselves, served from
the root-owned image copy), and every dangerous verb re-runs it
server-side — the page's verdict display is a courtesy, not the check.

It cannot promise "the built artifacts correspond to the source" by
itself, because any real build executes parts of the tree as code. That
gap is closed as far as structurally possible by *where and how* the build
runs (§2: offline, pinned toolchain, `astro.config.mjs` + lockfiles
protected, `tsc` never executes source, output confined to the release
dir) and bounded honestly in §1.5.

### 1.5 Residual risks (named, not hidden)

1. **Build-time code execution from the target tree.** `astro build`
   executes `astro.config.mjs` (protected) and its import closure
   (`src/lib/env-schema.ts`, `src/schemas/uploads.ts` — env-schema
   protected; uploads.ts is inert data). Vite SSR-bundles page/lib code
   without evaluating it (no prerendered pages exist; `output: 'server'`).
   `tsc` type-checks and emits only. A tree could still smuggle a build
   hook through an unprotected file *if* a future refactor adds one to
   the build's executed closure — the review rule is: **anything imported
   by `astro.config.mjs` belongs in the protected set.**
2. **SHA-1 collision.** Git object ids are (by default) SHA-1; a
   collision could make two different trees share a sha. Chosen-prefix
   collisions exist in the wild; crafting two valid web-pi trees with one
   is a nation-state-grade effort against a single-user homelab app. Git
   ≥ 2.29 also detects the known collision shapes on transfer (not on
   local object creation). Accepted residual; SHA-256 repos would close
   it.
3. **The page can lie.** A patched page could show a fake "allowed"
   verdict — but apply/activate re-check server-side and answer
   `enforcement_rejected` (422) with the offending paths. The lie costs
   the attacker nothing and gains nothing.
4. **The human.** The page requires password re-confirmation on every
   dangerous verb (below), but nothing stops the operator from following
   hostile instructions ("just run these commands in a session") — that
   is out of scope by definition; the terminal is the product.
5. **`git archive` honors the target tree's `.gitattributes`**
   (`export-ignore`, `export-subst`) — an unprotected tree can shape what
   the builder materializes. Bounded: `export-ignore` can only DROP files
   from the release (worst case a broken release the human catches and
   rolls back — the gate, auth and state never ship from a release, §3.1),
   and `export-subst` only interpolates commit metadata into file
   contents the tree already authored. Neither grants a capability the
   unprotected paths don't already carry; in-tree `.gitattributes` cannot
   be switched off for `git archive`, so it is named here instead of
   neutralized in the builder.

### 1.6 The verbs and their guards

| Verb | Guards |
| --- | --- |
| GET state / commits / preview | session (main.ts gate) only — read-only, no secrets beyond paths and shas |
| POST build | re-auth (`username`+`password`, verified via `auth.verify` — 401 on mismatch), enforcement re-run (422 `enforcement_rejected` with the offending paths), one build at a time (409), releases volume configured (503) |
| POST activate | re-auth, enforcement re-run for a release target (base = the sha currently recorded as served), release must exist + manifest match + layout valid (404/409), then pointer write + recorded history + restart |

Every POST is already origin-checked by `server/main.ts`'s gate (present
but foreign `Origin` → 403 before Astro) and session-checked; the
re-confirmation password is the second factor against a stolen-but-live
cookie (an XSS elsewhere on the origin could fetch with the cookie, but
does not know the password).

## 2. Where the build runs — the builder sidecar

**Decision: a `builder` sidecar from the dev-target image (toolchain
present), sharing the workspace volume (read the checkout) and the
releases volume (write the release), triggered by marker files on the
releases volume. Never a docker socket in webpi; never HTTP from webpi
into the workspace side.**

Why not the alternatives:

- **Build in the webpi container** — it is the least privileged half *by
  design* (no toolchain in the slim image; and putting the builder's
  attacker-influenced workload into the gate container inverts the whole
  model).
- **Host-side build only** — safest, but makes the page read-only theater
  and leaves the TODO's "rebuilding, swapping" unimplemented. Kept as the
  documented fallback for hosts that don't want the sidecar (§7): the
  page's verdict/preview machinery is exactly the pre-flight for
  `GIT_SHA=… docker compose build`.
- **docker socket anywhere near webpi** — a docker socket is root on the
  host; rejected categorically (this is also why the swap cannot
  `docker restart` itself, see §3).

Privilege shape of the chosen design: web (unmodifiable trigger) writes a
request marker; a dedicated `builder` user (uid 2010, primary group
`webpi` to READ the checkout, extra group `releases` (gid 2011, web +
builder only) to write the volume) does the work; the output lands on
the releases volume, which web validates and serves. Deliberately **not**
uid 2000 (the sessions' uid): sessions would then be able to forge release
dirs and done markers themselves — the thing `activate` validates and
web serves. The monotone-core argument still holds: the build work happens
in a container whose ONLY privilege over a session is writing the
releases volume, everything it writes there is validated (manifest sha
match + layout) and still gated by the enforcement re-run at activate, and
the sessions' uid is in neither group that writes it. The build executes
attacker-chosen tree code (see §1.4) — it must never run as the gate uid,
or with a docker socket, or as an id that can forge the protocol web
trusts. The `releases` group IS the boundary: node + builder in, uid 2000
out (compose's `releases-init` makes the protocol dirs 2770 `node:releases`
and the pointer dir 0750 `node:node`).

Builder recipe (scaffolded in `deploy/` + compose; the *contract* is
implemented and unit-tested on the web side):

1. Watch `pending/` on the releases volume for `<sha>.json`
   `{sha, base, requestedAt}`; claim by renaming to `building/`.
2. Materialize the tree content-addressed: `git archive <sha> | tar -x`
   into a scratch dir (never build the working tree — the attacker can
   mutate it between check and build; the sha cannot be mutated).
3. Reuse the image's own `/opt/web-pi/node_modules` (copy it into the
   scratch tree). The lockfile is protected ⇒ the deps are identical to
   the image's; node-pty arrives prebuilt; **no network, no
   `npm install`, no lifecycle scripts from the tree run**.
4. `npm run build` with the image's toolchain (the `build` script is
   pinned by the protected `package.json`), `NODE_ENV=production`,
   offline. Output: `dist/` only (see §3.1).
5. Write the release dir atomically: build into a scratch dir, then
   `rename` to `<sha>/` with `manifest.json`
   `{sha, builtAt, builder}` + `dist/`; then `done/<sha>.json`
   `{sha, status: "built"|"failed", log, builtAt}`.

The marker protocol (file names, JSON shapes, who writes what) is the
implemented contract — `src/schemas/management.ts` (node-free) + read/
write helpers in `src/lib/releases.ts`, unit-tested against a fake
builder that plays the filesystem side of the protocol. Ops note: a
crashed builder can leave a claimed `building/<sha>.json` behind, and
`anyBuildActive` then answers 409 `build_active` for every new build —
the recovery is host-side: `docker compose exec webpi sh -c 'rm -f
/releases/building/*.json'` (web owns the volume's protocol dirs too).
A builder-side sweep is deliberately NOT the page's job: web never
deletes protocol files it did not write itself.

## 3. The swap

### 3.1 What a release contains — and why not `dist-server/`

A release is `dist/` (Astro client assets + the SSR handler
`dist/server/entry.mjs`) + `manifest.json`. **The release deliberately
does not replace `dist-server/`** — the running Node process keeps
executing the image's root-owned `server/main.js`, `src/lib/*`,
`node_modules`: the gate (origin check, session check, body caps,
security headers), auth, tmux, the scheduler, and the enforcement itself
all stay image-resident **by construction, not just by the diff check**.
A release changes what the gate *serves* (pages, partials, API routes,
client bundles), which is what "applying changes" means. Server-side
changes in a release's commit are honest no-ops until the next image
deploy (the page says so), and the diff check still refuses commits that
touch the protected server files — because the human's next image build
is from this tree.

This is the strongest structural statement of the TODO's headline
property: the gate *cannot* be swapped from inside the container, even by
a successful apply.

### 3.2 Serving a release — pointer + self-exit

- `WEB_PI_RELEASES_DIR` (env, unset by default) mounts the releases
  volume. Unset → the page runs in read-only/dry-run mode (state,
  commits, preview verdicts; build/activate answer 503
  `releases_not_configured` with the compose snippet in the message).
- At boot, `server/main.ts` resolves what to serve: read the pointer file
  (`<releases>/pointer/current`; absent → the image copy) → validate that
  release's dir (`manifest.json` with matching sha,
  `dist/server/entry.mjs` exists, `dist/client/` non-empty) → serve its
  entry/client; anything invalid falls back to the image copy **with a
  loud boot log**. The running process never changes its mind mid-flight
  — a release becomes served only by a restart. The pointer is read
  before any state-db use on purpose (the db opens lazily and stays that
  way, db.ts).
- The restart needs no docker socket: `activate` writes the pointer,
  answers the page, then the server exits through its **existing graceful
  shutdown path** (drain sockets, `process.exit(0)`) — docker's
  `restart: unless-stopped` brings it back on the new release. On a bare
  host install the exit lands on the operator's supervisor (systemd) —
  or nothing; the doc says so. Web restarts don't end sessions (tmux
  lives in the workspace container); open terminals get the `restart`
  message and reattach.

### 3.3 Rollback

Rollback is the same machinery pointed elsewhere: activate a previous
built release (`target: "<sha>"`), or `target: "image"` — which clears
the pointer so the next boot serves the image copy. No rebuild needed;
re-auth + history recording exactly like activate. Release history lives
in the state db (`releases` table, schema v5):

```sql
CREATE TABLE IF NOT EXISTS releases (
  sha          TEXT PRIMARY KEY,   -- full 40-hex source sha
  status       TEXT NOT NULL,      -- 'requested' | 'built' | 'failed' | 'applied'
  requested_at INTEGER NOT NULL,   -- epoch ms
  built_at     INTEGER,            -- epoch ms the builder finished
  applied_at   INTEGER,            -- epoch ms it first became the served release
  log          TEXT                -- capped builder output tail
);
```

plus the web-only pointer file (§1.2/§3.2 — the releases volume, not the
db). Old release dirs are never auto-deleted (rollback targets must
stay); pruning is a future, explicitly-confirmable action.

## 4. The page (`/management`)

Cards, following the `/settings` conventions (Web Awesome, SSR-first,
`[data-refresh]` plain-HTML regions swapped from `/partials/management`,
dialogs outside those regions):

1. **Serving now** — image version + baked git sha + build time, or
   release sha + built time; the releases volume's configured-ness.
2. **Workspace checkout** — path, present?, HEAD sha, branch, dirty-file
   count (all read-only git on the `:ro` mount), or the "clone a
   checkout" guidance when absent.
3. **Apply a commit** — the commit list (recent 50: sha, subject, date);
   picking one fetches the server-rendered **preview** (the dry-run
   verdict): changed-path counts, the protected hits by name with each
   one's rationale, and the verdict badge — *before* any verb. Build
   (re-auth dialog) → build status with the builder log tail (polled) →
   Activate (re-auth dialog) → "restarting…" then auto-reload once the
   server answers again.
4. **Releases & rollback** — the history table (status, times) with
   Activate/Roll-back-to-image actions, same re-auth dialogs.

The preview verdict is computed server-side in every case; the page never
decides anything.

## 5. API surface (thin routes behind the main.ts gate)

| Route | Family | Notes |
| --- | --- | --- |
| `GET /api/management` | `management_state` | everything the page renders; `database_error` only |
| `GET /api/management/commits` | `list_commits` | recent commits of the checkout; `checkout_missing` (404), `git_error` (500) |
| `GET /api/management/preview?sha=…` | `enforcement_preview` | verdict as data; `checkout_missing`, `base_unknown`/`base_not_in_checkout` (409), `target_not_found` (404), `git_error` |
| `POST /api/management/build` | `request_build` | re-auth (`invalid_credentials` 401), enforcement (`enforcement_rejected` 422 + offending paths), `releases_not_configured` (503), `build_active` (409), preview's codes |
| `POST /api/management/activate` | `activate_release` | `target: sha\|'image'`; re-auth, enforcement (sha targets), `release_not_built` (404), `release_invalid` (409), `releases_not_configured` (503), `database_error` |

Request bodies are parsed with the shared node-free schemas in
`src/schemas/management.ts` (`confirm` must be the literal `true` — the
dialog's checkbox; `username`/`password` for re-auth; `sha` a 40-hex
branded `CommitSha`). Result families, statuses and mappers follow
`docs/CODE_STYLE.md`; HTTP never leaks into `src/lib`.

## 6. State & env additions

- State db migration v4 → v5 (`releases` table, §3.3) — additive.
- Env schema (surgical, junction-commented for the sibling merges):
  - `WEB_PI_RELEASES_DIR` *(optional)* — releases volume; unset disables
    the swap half.
  - `WEB_PI_MANAGEMENT_CHECKOUT` *(optional)* — the checkout the page
    reads/applies from (compose: `/workspace/web-pi`; the dev profile can
    point it at `/app`).
- `Dockerfile`: `ARG GIT_SHA` + `version.json` in the build stage;
  `compose.yaml` passes `GIT_SHA: ${GIT_SHA:-unknown}` through the shared
  build args (junction-commented).
- `server/main.ts`: boot-time serve-dir resolution + an injectable
  `requestRestart` (the graceful-shutdown path) — both surgical,
  junction-commented.

## 7. Implemented vs scaffolded, and host verification

**Implemented (unit-tested in this sandbox):** the enforcement core
(protected set, normalization, `-z` diff parsing, verdicts) against real
git fixtures; the base chain of trust; the git reads (commits, HEAD,
dirty, diff) with `safe.directory`; the marker protocol read/write; db
migration + release rows; pointer write, release validation,
`resolveServingDirs` boot resolution; re-auth + origin-gated API routes;
the page and its dialogs.

**Verified in a sandbox without a C++ toolchain** (node-pty can't build →
the full server can't boot → `npm run test:e2e` can't run there):

```sh
npm run check                          # types + the .astro files
npm run test:unit                      # tsc first; enforcement + marker + swap
node tools/verify-management-ssr.mjs    # after `npm run build`: the page SSR,
                                       # the partial, and every /api/management
                                       # route + status mapping through the REAL
                                       # Astro entry (dist/server/entry.mjs) with
                                       # stubbed locals + a REAL Releases service
                                       # over a REAL git fixture
```

On a host with a toolchain, chromium and tmux, the e2e half runs:
`tests/management.spec.ts` (spawns its own server child on :3484 with the
management env — it runs after `e2e.spec.ts`, whose login-rate-limit test
spends the shared webServer's whole per-IP budget, so it must not touch
the shared instance's login) covers the page as a browser sees it: SSR,
the partial-refresh verdict BEFORE any verb, the re-auth dialog path, the
refusal statuses, the pending marker as the only effect, the origin gate.

**Scaffolded (needs a real docker host):** the builder sidecar
(`deploy/builder-entrypoint.sh` + the compose `builder` service +
releases-volume init) and an end-to-end apply/rollback with a real
container restart (the swap itself — pointer write, validation, the
graceful-exit restart — is unit-tested; only the builder's real build
and the container's real restart need the host).

Host verification steps (run from the original project on the host):

```sh
# 0. sanity: the image records its sha
GIT_SHA=$(git rev-parse HEAD) docker compose build
docker compose run --rm --entrypoint cat webpi /opt/web-pi/version.json
# → {"git":"<sha>","builtAt":"…"} ; "unknown" means the ARG was not passed

# 1. wire the management volumes (scaffolded service block in compose.yaml)
docker compose up -d    # builder + webpi get the webpi-releases volume

# 2. put a checkout on the workspace volume (README self-modification)
docker compose exec workspace git clone <your-fork> /workspace/web-pi

# 3. on the page: /management → the checkout card shows HEAD; pick the
#    image's own sha in the commit list → preview says "no changes";
#    pick a commit that edits e.g. README.md → preview lists it, allowed;
#    hand-craft a commit that edits compose.yaml → preview must refuse
#    (and POST /api/management/build answers 422 with the path).

# 4. build + activate: watch the builder pick up the marker
docker compose exec builder sh -c 'ls /releases/pending /releases/done'
# then activate on the page: webpi exits 0, restarts on the release;
# verify: docker inspect webpi --format '{{.State.StartedAt}}' moved,
# the page's "serving now" shows the release sha + build time.

# 5. rollback: activate the previous release (or 'image') on the page;
#    the serving card must return to the previous sha.
```

## 8. Coordination junctions (sibling tasks)

- `src/lib/env-schema.ts`, `src/lib/services.ts`, `server/main.ts`,
  `compose.yaml`: edits are surgical and marked `// task/mgmt-page:` —
  the siblings (task/winston-loki, task/zed-webapp) add their own env
  keys/services; the blocks do not overlap textually.
- `src/lib/db.ts` schema v5 is additive; winston-loki's logger touches
  boot logging, not the schema.
- The builder service in compose is a separate top-level block; the
  zed-webapp service is another — no shared lines.

## 9. Follow-ups (out of scope, on purpose)

- Narrow `WebPiServices.auth` (exposed to release code for
  `/api/state`'s cookie refresh; a verify-only facade would shrink the
  release's capability surface).
- Release pruning; scheduled auto-apply; notifications.
- SHA-256 git repos if the collision residual ever matters.
