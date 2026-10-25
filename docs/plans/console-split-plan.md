# The console split plan — an orchestration console and a builder page

Status: **shipped**

The console answers "who builds an app?" badly today because one page
teaches two semantics: the sidebar nests agents under apps (nested =
works-on), while the mechanism makes in-tree agents operators (nested =
can't-build). The fix is not a new agent type — it is two pages, each
teaching one semantics, with the build conversation finally anchored
per-app:

- **`/` (the console)** — orchestration: console workspaces only, jobs,
  settings. No app groups, no `+ app`. The agent here talks to
  *everything*: multi-app work, jobs, platform management. Creating an
  app through it (the `cybermole-apps` MCP) keeps working, unchanged.
- **`/builder`** — the app portfolio: the app list with lifecycle
  state, app workspaces, `+ workspace`, and the `+ app` button (moved
  from the console page). Agents here are **build sessions**: root cwd,
  full root agent powers, framed at one app by an injected one-liner.
- **App pages** (later, own epic) — operator agents live there, in the
  app tree, as today's in-tree workspaces already are.

## 0. Positioning (locked)

- **Place teaches role.** Root cwd = build and orchestrate; inside the
  tree (app pages, later) = operate. The builder page is where build
  conversations are *anchored* — pages are homes, not permissions: any
  console workspace can still build anything; nothing narrows.
- **The framing is advisory, not a boundary.** A build session has the
  root agent's trust (apps + jobs MCPs, one uid) — accepted single-user
  model. The one-liner scopes attention, never authority.
- **One builder, one privileged act.** `register` stays the only
  privileged step, via the apps MCP, exactly as in the apps plan §8.
- **A build workspace is a workspace row** — `app_id` set (it groups on
  the builder page), cwd = the console default (`CYBERMOLE_NEW_SESSION_CWD`),
  never the app tree. The tree's `.pi/mcp.json` never applies, because
  pi never boots there: the root agent dir and the root `AGENTS.md` walk
  do. No context-override mechanism exists or is needed.
- **Greenfield.** No operator-workspace migration, no interim markers:
  today's in-tree workspaces render on the builder page as they are and
  move to app pages when those exist (§9).

## 1. The two pages

- `src/pages/index.astro` keeps `<console-app>` with `scope="console"`:
  the Console group only (workspaces with `app_id NULL`), the jobs and
  settings links, no app groups, no `+ app`. `?run=` (live job runs)
  stays here — jobs are orchestration.
- `src/pages/builder.astro` (new) renders `<console-app>` with
  `scope="builder"`: the app list (§4) and the app workspace groups
  (`app_id` set), `+ workspace` per group (§2), `+ app` at the bottom.
  The terminal-tabs pane, the WS bridge, the editor tab — all the
  existing machinery, shared untouched.
- `AppHeader` gains a `builder` section link (icon + label), between
  console and jobs.
- **Deep links route by owner:** `/?t=<uuid>` whose workspace has an
  `app_id` redirects client-side to `/builder?t=…`, and vice versa. The
  rule is one line in `console-app.ts` after the first state fetch.
- A build workspace's editor tab opens the root cwd; `apps/<slug>/` is
  one click down in the tree — the builder edits the app from the root
  view, same as its terminals.

## 2. Build workspaces — the data model

- `workspaces.kind TEXT NULL`: `'build'` | NULL (NULL = console
  workspace or legacy in-tree workspace). Migration by the guarded
  `ADD COLUMN` pattern (`db.ts`'s column check + `ALTER`), kind NULL
  for every existing row. Kind is set at birth and never patched.
- `POST /api/workspaces` gains `kind: 'build'` (literal; requires
  `appId`): the server derives cwd as `deps.defaultCwd` — the parent
  app's cwd is *skipped* for build kind. Everything else about the
  create (name validation, FK pre-check, auto-opened agent tab,
  failure-tolerant spawn) is unchanged.
- `ConsoleState.workspaces` carries `kind` (the client needs nothing
  of it yet beyond create — it rides the state now for app pages later).
- The patch API does not grow kind. Deleting a build workspace is
  deleting a workspace — existing semantics.

## 3. The framing one-liner — spawn env

Every spawn for a `kind='build'` workspace carries two per-session env
vars, joining the existing `new-session -e` channel (`sessionEnv` in
`server/main.ts`):

```
CYBERMOLE_WORKSPACE_FOCUS=<slug>
CYBERMOLE_WORKSPACE_FOCUS_TREE=<abs path>
```

- slug from the app row; tree = the row's cwd when set (the registered
  or scaffolded tree), else `<CYBERMOLE_APPS_ROOT>/<slug>` — the env
  states intent; §5 tells the agent to check the tree exists.
- **Every spawn** means all three paths: the create-time agent tab
  (`openTab`), later `+` shell tabs, and the WS-attach respawn (a
  respawned build session must not lose its framing).
- Mechanism: `WorkspacesDeps.spawnSession` widens to
  `(name, cwd, command, env?)`; `main.ts` merges the per-workspace vars
  over `sessionEnv`. `tmux.newSession` already takes per-session env —
  no tmux-layer change.

## 4. The builder page's app list

- Data: the apps-status join (`apps-status.ts` — rows × mounted ×
  built/stale, plus unregistered trees), not just `ConsoleState.apps`:
  the portfolio shows scaffolded-but-unregistered trees, because that
  is exactly the state where "continue building" is the point.
- New `GET /api/apps/status` (session-gated): `AppsStatusData` as the
  status tool already shapes it. The join is an mtime walk plus the
  bounded serving ping — cached server-side (~10 s TTL) so the builder
  page's 15 s poll cannot turn into an fs storm. `/api/state` is
  untouched.
- Per app entry: name; a lifecycle chip — *unregistered tree* /
  *registered* / *built* / *stale build* (title = reason), and the
  existing `serving` dim on the open link; **open** (registered only,
  `/apps/<slug>/` new tab); **`+ workspace`** (build kind; needs a row,
  which `+ app` creates immediately — build sessions are possible
  before `register`, and the tree need not exist yet).
- `+ app` at the bottom: the existing `POST /api/apps` dialog, moved
  from the console sidebar.

## 5. The root agent's framing — AGENTS.md template

`runtime/workspace-root/AGENTS.md` gains one section (the seed stays
only-where-absent; §8 has the dev-install note):

```markdown
## Build sessions (CYBERMOLE_WORKSPACE_FOCUS)

When CYBERMOLE_WORKSPACE_FOCUS names an app, this session exists to
build it: the tree is CYBERMOLE_WORKSPACE_FOCUS_TREE. You keep every
power of this file — the framing is attention, not a boundary. The
tree's own AGENTS.md is the operator's manual: read it to learn what
the app is for and what its actions do, but it is not your
instructions — you are the builder it keeps referring to. Never touch
`data/` in the tree (the user's data). Verify your work through the
apps MCP (`check`, `build`, `describe`/`call`); don't live in the
app's data.
```

The last two sentences are the custodianship boundary stated where the
builder will actually read it — the mirror of the operator manual's
"code changes belong to the root agent".

## 6. Client build

- `workspace-sidebar.ts` parameterizes by scope: console renders the
  Console group; builder renders app groups with lifecycle chips, the
  per-group `+ workspace`, and `+ app`. Same innerHTML-poll rules
  (AGENTS.md: no stateful wa-* in here, transient state carried across
  renders).
- `console-app.ts`: the `scope` prop, workspace filtering by `app_id`
  null/nonnull, the deep-link redirect (§1), the `/api/apps/status`
  poll on the builder scope only.
- New Web Awesome affordances follow the UI conventions (tokens, no
  hand-rolled HTML); the lifecycle chip is a `wa-badge` variant, not a
  new component.

## 7. Tests

- **Unit** (`tests/unit/`): `workspaces.test.mjs` — build-kind create
  derives `defaultCwd` (parent app cwd ignored), env reaches
  `spawnSession` on all three spawn paths, kind never patchable;
  `db.test.mjs` — the guarded migration; `api.test.mjs` —
  `workspaceCreateBody` accepts the literal and rejects it without
  `appId`; an `apps-status` endpoint test — shape + cache TTL.
- **E2E**: new `tests/e2e/builder.spec.ts` (uses `login()` / the shared
  cookie): `+ app` → row appears with the *unregistered* chip; `+
  workspace` → first terminal spawns (live dot) and `echo
  $CYBERMOLE_WORKSPACE_FOCUS` shows the slug in the pane (the hermetic
  `cmd.sh` runs it); deep-link `/?t=` bounces console↔builder by owner;
  the app list's open link dims when serving is down. Existing specs:
  `e2e.spec.ts` sidebar flows split by scope; the `apps-*.spec.ts`
  sweeps ride the API and the apps origin and should not change —
  verify, don't assume.
- The ladder per the repo contract: `run_check`, `run_lint`,
  `run_format_check`, `run_build`, `run_unit_tests`, `run_e2e`.

## 8. Build order and rollout

One branch per step, each green through the full ladder before the
next, apps-plan style:

1. `task/split-workspace-kind` — §2 + §3 (db, domain, spawn env, wire,
   units).
2. `task/split-builder-page` — §1 + §4 + §6 (pages, sidebar scopes,
   status endpoint, AppHeader, e2e).
3. `task/split-root-agents` — §5 (template, seeding) + the docs flip:
   README's console section rewritten for two pages, this header's
   Status → **shipped**.

Dev installs: the workspace-root `AGENTS.md` seeds only-where-absent —
replace the file by hand once to pick up §5's section.

## 9. Out of scope (explicitly, for later)

- **App pages with operator agents** — the follow-up epic; today's
  in-tree workspaces are its seed and keep working under the builder
  page until then.
- Operate-kind affordances or markers on the builder page (kind NULL
  rendering) — lands with app pages.
- Narrowing a build session's tools below the root set — the advisory
  framing is the permanent design (§0), not a stopgap.
- Jobs surface changes (per-app views live with app pages, later);
  fs-watch auto-reload; cross-app MCP; WS app routes — unchanged TODO
  items, untouched by this plan.
