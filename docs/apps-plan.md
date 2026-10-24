# The apps plan — extensions: agent-built webapps mounted in cybermole

Status: **shipped** — all six §11 branches landed on main, in build
order: `task/app-host` (c8ffa78, §3), `task/app-kit` (39b4518, §5 —
landed second: the host's fixture run wanted the kit's shape settled
before the web side built on it), `task/app-web` (c8ccb86, §4),
`task/app-scaffold` (900eeee, §6+the starter), `task/app-actions`
(471a923, §1's add_action/describe/call + the shim), and
`task/app-notes` (this branch — §9's reference app, built through the
verbs as the acceptance run, plus the docs flip that flipped this
header). Integration amendments, told where they changed the agreed
plan: main.ts's static+middleware factoring stayed a stretch and was
not taken — the app host carries its own small serve helper (§3); the
socket-client unification landed as src/lib/internal-api-client.ts in
branch 1, and mcp.ts still has its local one (the jobs MCP was left
untouched by the apps epic); branch 4 added CYBERMOLE_APPS_ROOT (the
apps root env the verbs and the host share); the reference app's run
found and fixed two real kit/generator bugs — zodToJSONSchema read
optionality after unwrap() so every .optional() field emitted as
required, and add_action's manual parser swallowed a field literally
named `body`/`query`/`params`; and the shipped reference tree lives at
apps-reference/notes with image-baked install paths (/opt/cybermole),
seeded only-where-absent by the workspace entrypoint, its e2e re-seeding
the same tree into the hermetic apps root per run. The body below is
the plan as agreed — the historical record, unchanged.

## 0. Positioning (locked)

- **Apps are extensions of one install, not publishable apps.** "App" is
  the user's mental model and the name of the feature; there is no
  distribution, publishing or independent-versioning story. The image is
  the distribution: the kit, the templates, the host and the core
  dependencies all ship with cybermole and upgrade with it.
- **Same stack, same standards as the console.** Astro SSR (middleware
  mode) + Web Awesome (astro-lit, declarative shadow DOM) + preact
  islands with signals for client state + zod + the Result family +
  `node:sqlite`. Apps follow docs/CODE_STYLE.md; the scaffold bakes the
  conventions in so agents inherit them by construction.
- **The appliance split stands** (jobs-agent-plan §0). The web container
  serves root-owned code and **never imports app code**. Apps run in the
  app host on the workspace side (uid 2000) — what this plan adds is a
  deliberate, registered mount point behind the session gate, not a
  plugin framework in the web process. An app's lifecycle remains its
  own business (its git repo, its tagged jobs); cybermole mounts what is
  registered, nothing more.
- **Root agents build; app agents operate.** A cybermole-level (root)
  agent scaffolds, codes, checks, builds, registers and extends apps
  through the `cybermole-apps` MCP. An app-level agent — a pi session in
  a workspace under the app — **uses the app's features** through the
  app's own MCP; it does not build. Role separation is enforced by tool
  availability (§7), not by filesystem denial.
- **One action vocabulary per app.** The app's route table is the single
  source of truth; the web UI, the app's MCP tools and the root agent's
  `describe`/`call` are faces of the same table — same Result JSON, same
  closed error codes (the jobs surface's pattern, generalized). This is
  construction (the kit binds the table to every face), never a
  convention agents must remember.

Prior-plan amendment, told where it changes the agreed plan: jobs-agent
plan §2 granted the workspace side jobs control and drew the line at
app management — the boundary as stated in code (the read-only
`apps_list` route's comment in server/internal-api.ts: "creating and
managing apps stays on the console surface"). This plan deliberately
reverses that clause: the internal API grows `app_save`/`app_delete`
verbs (§4) so agents can register and unregister apps, and that
comment is rewritten in the same branch (§11). Everything else in §2's
trust boundary holds unchanged.

## 1. Concept model and roles

| Actor | Job | Surface |
|---|---|---|
| Human | Use apps; manage everything | Browser: `/apps/<slug>/` behind the login; the console as today |
| Root agent | Build & modify apps; drive any app | `cybermole-apps` MCP (§6) — scaffold, add_action, check, build, reload, register, describe, call |
| App agent | Use one app's features on the user's behalf | The app's MCP via the tree's `.pi/mcp.json`; its AGENTS.md as user manual (§7) |

The **build loop** (root agent): `scaffold` a starter → code on the
house stack → `check` (astro check + tsc + unit + build, one quiet
envelope) → `register` (the db row — the tree has existed since
scaffold, so the cwd check passes) → `reload` (the host's sync point:
re-discover rows, then mount/re-import — row + manifest + build is
what mounts) → write the app's AGENTS.md (§7). The same sync after
`unregister` drops the mount. `add_action` extends an app in lockstep:
route + MCP tool + UI stub + test stub + the AGENTS.md action section,
all from one table entry.

The **use loop**: the sidebar's app group → `+ workspace` (existing
machinery — a workspace under the app starts at the app's cwd) → pi in
the tree (one project-trust prompt) → "journal today's standup" against
the app's tools. The human does the same through the UI; a root agent
can do it from anywhere via `describe`/`call`.

Apps may interrelate: sibling calls are plain HTTP through the host
(kit client, shared Result contract), jobs can be tagged per app
(shipped), and object storage is available (shipped). Cross-app MCP
registration is deliberately later (§12).

## 2. Anatomy of an app

```
/workspace/apps/<slug>/          its own git repo (git init at scaffold; agent undo)
  app.json                       manifest: name, description, mount slug
  package.json                   core stack declared, resolved from the image (§5)
  astro.config.mjs               base: '/apps/<slug>' baked at build; node adapter
                                 (middleware mode); astro-lit; preact islands
  src/routes.ts                  THE route table (zod in → Result out) — single
                                 source of truth; emits dist/route-table.json at build
  src/pages/, src/components/    the UI (SSR pages + signal islands)
  src/lib/                       the app's own domain code + data/ (app.db, gitignored)
  AGENTS.md                      the operator's manual + policy (§7)
  .pi/mcp.json                   the app's MCP shim; cybermole-apps disabled (§6)
  dist/                          astro build output + route-table.json
```

- The db row (existing `apps` table) stays structural: name, slug
  (stable — workspaces-plan §6), `cwd` = the tree at register time.
  The manifest is the app's self-description; the db never grows app
  semantics.
- `data/app.db` — the app's own `node:sqlite` database (kit helper,
  same pattern as the state db). Apps never touch cybermole's state db.
- Slugs are stable once created, so the baked base path never goes
  stale. Console `DELETE /api/apps/:slug` keeps its cascade semantics
  for structure (workspaces/terminals) but never removes the tree — the
  tree is unregistered, not deleted (§4).
- A terminal in the tree can run anything a terminal can run today,
  including `astro dev` on a loopback port during hand-development.
  The platform surface is the host socket; nothing here polices
  terminals.

## 3. The app host

A small Node server shipped in the image (`server/app-host.ts` →
`dist-server/server/app-host.js`), running on the workspace side: **a
mini `main.ts`**. It listens on a unix socket in the shared socket dir
(`/run/cybermole/apps.sock` in compose, `<state dir>/apps.sock` on a
plain host — the two shapes `CYBERMOLE_SOCK` gives the internal API;
same 0660 + group `cybermole` conventions as the tmux socket). Env:
`CYBERMOLE_APPS_SOCK` — absolute path override, **empty = the apps
surface is off** (`/apps/*` answers 404; `reload`/`call`/the shim fail
with a clear error) — the `CYBERMOLE_SOCK` rules verbatim, one env
every client reads (the web proxy + serving ping, the management
verbs, the shim). And:

- **Discovers** registered apps by reading the internal API's existing
  read-only `apps_list` plus each tree's `app.json` and `dist/`. Apps
  with a row + manifest + build are mounted; anything missing is
  skipped and reported. Discovery runs at boot and on every reload
  poke; at boot it retries until the internal socket answers (the
  compose boot race — the web server may not be listening yet), and a
  later web restart needs nothing: rows persist in the db, and the
  next poke re-reads them.
- **Mounts** each app's built Astro middleware (`dist/server/entry.mjs`)
  at its baked `base` path and serves its `dist/client` assets — the
  same static+middleware split `server/main.ts` performs for the
  console, factored so both use it.
- **Dispatches actions as their own HTTP** — a route-table entry
  already names method + path, so the shim, `call` and sibling
  clients issue that very request against the host socket; there is
  no parallel RPC to invent or let drift. The host's only extra
  routes are admin (`/_admin/reload`, `/_admin/status`) —
  socket-local, never proxied.
- **Reloads** on demand: the `reload` verb pokes the admin route on the
  host socket; the host re-runs discovery, then mounts, re-imports
  (cache-busted import) or drops the named app. Reload is the single
  sync point — register/unregister write rows, reload makes the
  mounts match them. No fs-watch in v1 (§12) — the loop is
  agent-driven.
- **Is per-app crash-tolerant at the registry level**: a throwing app
  handler is a 500 for that app's paths only (the host's own try/catch
  per mount, the `main.ts` pattern); a poison app that breaks mounting
  is unregistered via `app_delete` and the host restarts clean. Host
  down = `/apps/*` 502 with a console badge; the supervisor restarts it.

Ownership follows the `CYBERMOLE_TMUX_SOCKET` precedent exactly:
single-user shapes, the web server spawns and supervises the host as a
child (same uid); the compose split, the workspace entrypoint owns it
(web never spawns — an absolute socket path is the split signal, and
web is only a client on it). Boot order after the tmux server; the
entrypoint already supervises one process, this is its second.

## 4. The web side

Three small additions, nothing else changes in the web container:

- **The proxy** — `/apps/<slug>/*` in `server/main.ts`, behind the same
  session gate and origin checks as everything else (the `/editor`
  proxy's pattern, HTTP; WS when an app earns it — §12). No prefix
  rewriting: the app's base path is baked in, paths forward verbatim.
  Unregistered slug → 404; host down → 502.
- **Internal API verbs** — `app_save` / `app_delete` mirroring the
  console routes (`POST/PATCH /api/apps`, closed error codes from
  `src/lib/apps.ts` verbatim; no second vocabulary — the jobs MCP's
  rule). This is §0's recorded amendment to jobs-agent-plan §2, and the
  `apps_list` route comment that states the old boundary is rewritten
  with them.
- **Console affordances** — the sidebar app group grows an "open" link
  (`/apps/<slug>/`) for registered apps, and `GET /api/state` grows a
  per-app `serving` flag (a cheap host-socket ping, short-timeout with
  the failure cached until the next poll — a hung socket must never
  stall the state poll) so a dead host is visible, not mysterious.

## 5. The kit — `@cybermole/app-kit`

The extracted shared half of cybermole, shipped in the image at a
stable import path and resolved by apps through the image's
`node_modules` (the build bundles it; serve-time only ever imports
`dist/`). No version drift is possible — the appliance upgrade is the
kit upgrade.

Contents (extraction, not invention — each piece already exists in
`src/` and moves to the kit; the console keeps importing it from there):

- the Result family + branded-ID helpers (`src/types/`)
- the node-free zod schema pattern (`src/schemas/`) and
  responses.service's Result→HTTP mapping
- the `node:sqlite` db helper pattern (`src/lib/db.ts`'s shape)
- the **route table binder**: a table entry (name, method, path, zod
  in, handler → Result) bound to (a) an Astro catch-all API route,
  (b) MCP tool shapes for the shim, (c) a typed client for sibling
  calls — and emitted as `dist/route-table.json` at build for
  `describe`/`call` and the shim
- the wa-* client-import boilerplate (login.astro's two halves) and
  the **preact-signal island conventions** — apps adopt signals first;
  the console adopts whatever proves out (the TODO's preact item
  lands here)
- the storage client (`src/lib/storage.ts`) and a jobs-facing helper
  (the internal API socket client, shared with `server/mcp.ts`)

Core dependencies (astro, webawesome, astro-lit, preact, zod) resolve
from the image's `node_modules`, never a registry: the scaffold
creates a real `node_modules/` whose core entries are per-package
symlinks into the image's tree, and an app needing an extra installs
just that extra alongside them — the core symlinks untouched. (A
whole-dir link is the wrong shape: installing an extra would replace
it and orphan the core stack.) `check`'s first stage verifies the
core imports still resolve, so a bad install dies at the gate, not at
serve time.

One build property is load-bearing: the built `dist/server/entry.mjs`
must be self-contained apart from `node:` builtins — Vite externalizes
what it resolves through `node_modules`, and serve-time must never
resolve through a link an extra can disturb. It is verified on the
fixture app in §11 branch 1 (the built entry inspected for non-`node:`
imports; `vite.ssr.noExternal` pins the offenders, or the kit ships
compiled) and re-verified in branch 3 with the kit real — decided on
the fixture, not discovered mid-epic.

## 6. `cybermole-apps` — the management MCP

A stdio MCP server in the image, registered **user-level** in the pi
template's `mcp.json` (next to `cybermole-jobs` — every root-agent
session gets it). Tools answer in the internal API's wire JSON
verbatim; check/build answer one quiet envelope
(`{passed, counts, failures[]}` — the cybermole-dev tools' contract).

| Tool | What it does |
|---|---|
| `scaffold {name, description}` | `/workspace/apps/<slug>` from the starter template: git init, astro config with base baked, one example action wired end-to-end, `.pi/mcp.json` (shim + `cybermole-apps` disabled), AGENTS.md seeded from the template |
| `check {slug}` | astro check + tsc + unit tests + astro build, in the tree (workspace uid) — the gate before any report of done |
| `build {slug}` | astro build (check's build half, alone) |
| `reload {slug?}` | poke the host's admin route: re-discover, then mount/re-import/drop that app (every app when the slug is omitted) — the sync point after register/unregister or a rebuild |
| `register {slug}` / `unregister {slug}` | internal API `app_save` / `app_delete` (the row; tree untouched by unregister). `duplicate_slug` — a console-era grouping row may already own the slug — names the recovery in its answer: the human renames or unregisters the old group (no tree is touched) |
| `add_action {slug, name, …}` | the generator: table entry + test stub + UI stub + AGENTS.md action section, in lockstep |
| `describe {slug}` | the app's route table from `dist/route-table.json` |
| `call {slug, action, params}` | invoke an action through the host — the root agent's use path |
| `status {slug?}` | mounted/serving/build-stale flags, and unregistered trees present (manifest + build, no row) |

**`cybermole-apps` is disabled inside app trees**: the scaffold writes
`{"cybermole-apps": {"enabled": false}}` into the app's `.pi/mcp.json`
(pi's project-overrides-user mechanism). Operators don't scaffold —
the role boundary is tool availability, enforced by config the
scaffold owns.

**The app's own MCP** is a stdio shim shipped in the image
(`dist-server/server/app-mcp-shim.js <slug>`): stdio to pi, HTTP to
the host socket, tools 1:1 with the route table (names from it,
schemas from `route-table.json`, results verbatim Result JSON). The
tree's `.pi/mcp.json` registers it under the app's slug.

## 7. App agents and AGENTS.md

An app agent is a pi session in a workspace under the app (the
existing machinery: a workspace's cwd defaults to the parent app's).
It gets the app's MCP by project `.pi/mcp.json` after the standard
project-trust prompt, and its instructions by the upward AGENTS.md
walk.

The app's **AGENTS.md is written by the root agent as the final build
artifact** — a user manual and operating policy for the operator, not
build instructions: what the app is for, its actions (a section
**regenerated from the route table** by `add_action`, so the manual
cannot drift from the code), and policy ("archive, never delete";
"confirm destructive calls"). The image ships the template
(`apps-agent-template/`, the `root-agents/` precedent: seeded
only-where-absent, updated where the scaffold owns the file).

## 8. Security and trust

- App code runs as **uid 2000 in the host process on the workspace
  side** — exactly the powers of a terminal, no more. It can never
  enter the web process, touch `/opt/cybermole` (root-owned), or read
  the state db (web-uid volume). The privilege split's threat model
  ("a prompt injection in workspace-side code cannot swap the server
  or the credential") extends unchanged to apps.
- **Registration is the privileged act** — it writes a db row through
  the internal API, the same trust level as job creation (jobs-agent
  plan §2's boundary, minimally amended in §0 above). Unregistration's
  blast radius, said plainly: `app_delete` cascades that app's
  workspaces/terminals and kills their tmux sessions — killing
  sessions is already uid 2000's power (the tmux socket is shared), so
  the new grant is structural row deletion, the same accepted trust as
  job deletion; the tree itself is never touched.
- The host socket follows the tmux socket's conventions (0660, group
  `cybermole`, shared dir); only workspace-side processes and the web
  proxy speak to it. Apps are reachable only through
  `/apps/<slug>/*` behind the session gate — never a TCP listener in
  the platform surface.
- App MCP tool descriptions are app-controlled text consumed by
  agents — the same trust as any terminal command a user runs
  (single-user model, accepted for jobs; accepted here, stated once).

## 9. The reference app: notes/journal (acceptance target)

The first app built **through the verbs, not around them** — the
epic's acceptance run. Scope: capture (title/body/tags), list and
search, edit, archive; `data/app.db` sqlite; SSR list+editor pages
with a signal island for the editor; actions exposed identically on
UI, shim tools and `describe`/`call`; AGENTS.md written last; check
green throughout. No external calls — the cleanest shakedown of
scaffold → check → register → reload → operate. Once built it ships in
the image as the **reference app** (living documentation, like
`root-agents/`): the tree seeds only-where-absent, and the row is
per-install — nothing auto-registers (registration is the privileged
act, §8); `status` shows the unregistered tree, and one `register` +
`reload` makes it live. The scaffold's starter stays blank.

## 10. Tests

- **Units**: the host's registry (apps_list + manifest + dist → mounts;
  missing pieces skipped and reported), per-mount error isolation, the
  kit's binder (one table → HTTP route + tool shape + client + emitted
  route-table.json), the shim's table→tool translation.
- **E2E** (the hermetic suite grows, serial as always): the gate
  (unauthenticated `/apps/*` → login redirect); a fixture app
  registered into the hermetic workspace tree serving page + API +
  shim tools; unregister isolating a poison app. The rate-limit-last
  rule stands.
- **Per-app**: the check verb's unit stage is the app-side story in
  v1; a per-app e2e harness is deliberately later (§12).

## 11. Build order (task/* branches, one at a time, each green)

1. `task/app-host` — the host: registry, mounting, reload, units; run
   by hand against a fixture app (no web wiring yet — the row created
   through the console, `apps_list` already answers). That run also
   settles §5's load-bearing build property: the fixture's built
   `entry.mjs` inspected for non-`node:` imports.
2. `task/app-web` — the `/apps` proxy + gate + `serving` flag + sidebar
   link + internal API `app_save`/`app_delete` (and the old boundary
   comment rewritten, §0) + e2e.
3. `task/app-kit` — the extraction to `packages/app-kit` + image
   plumbing; console imports move, zero behavior change, ladder green;
   §5's self-containment check re-run with the kit real.
4. `task/app-scaffold` — `cybermole-apps` MCP: scaffold/check/build/
   reload/register/unregister/status + the starter template; units and
   e2e against the hermetic tree.
5. `task/app-actions` — `add_action` + `describe`/`call` + the stdio
   shim + AGENTS.md regeneration.
6. `task/app-notes` — the reference app built through the verbs (the
   acceptance run); README/TODO/docs flip, this header flips last.

## 12. Out of scope (explicitly, for later)

- Per-app e2e harness (kit will crib the console's hermetic pattern).
- Host fs-watch auto-reload (verb-driven first; watch when the loop
  demands it).
- Cross-app MCP registration (siblings stay HTTP in v1).
- WS routes for apps (the bridge code exists to crib when an app needs
  live data; the proxy grows `ws: true` then).
- Console app-preview pane (the sidebar link is v1).
- Apps binding TCP in the platform surface, publishing, multi-host —
  no shape for these exists and none is wanted.
