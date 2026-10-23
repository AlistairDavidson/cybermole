# The workspaces plan — sessions → apps/workspaces/terminals

Status: **shipped** — all six §13 branches landed on main, in build
order: `task/ws-schema` (3de0fdb), `task/ws-terminal` (cce609e),
`task/ws-editor` (c2d82cd), `task/ws-console` (7558909), `task/ws-jobs`
(cec51ae), and `task/ws-docs` (this branch — the docs refresh that
flipped this header; README/TODO/docs now describe the shipped
system). The editor shipped as VSCodium's reh-web build,
same-origin-proxied through cybermole. The "Disassociate sessions from
pi" / "Apps" sketches it superseded are gone from TODO.md. The body
below is the plan as agreed — the historical record, unchanged.

## 1. Concept model

- **App** — a named, slug'd, ordered container for workspaces. Barebones
  on purpose: name + slug + uuid + timestamps + ordering.
- **Workspace** — a working context: a **cwd** + terminal tabs + one
  editor (VSCodium reh-web) tab. Belongs to the console (`app_id NULL` —
  the console is *not* an app row) or to exactly one app.
- **TerminalSession** — one terminal tab = one tmux session on the
  existing socket. The cybermole state db owns the identity (uuid); pi is
  demoted from "what a session is" to "a command you can run in a
  terminal".

Hierarchy: `apps 1—M workspaces 1—M terminals`, console = the NULL app.

Locked decisions (from the design discussion):

1. New terminal tabs run a **login shell** (`$SHELL -l`), not pi.
   `CYBERMOLE_COMMAND` is repurposed: "the command a new terminal tab
   runs", default the login shell. pi stays a vendored dependency
   (update button, auto-update) because terminals still run it by hand.
2. The sidebar **is** the app switcher: workspaces grouped by app
   (Console group first), filter on workspace name. No separate top-bar
   app switcher.
3. Jobs are **global with an optional `app_id` tag** — never owned by a
   workspace or app. The jobs management page stays; jobs gain
   **persisted run logs** and log viewing.
4. The **Live** tmux-sessions sidebar section is dropped. Terminal tabs
   carry live flags; job runs are viewable from the jobs page.
5. All pi-session-shaped features are deleted (store scan, hidden flags,
   resume). Greenfield: no backwards compatibility, state db moves to
   schema v6 — **additively in branch 1, destructively only in branch 4**
   (`task/ws-console`, §13).
6. The editor is **VSCodium's reh-web build** (`codium serve-web` —
   self-hosted VS Code in the browser with server-side files), replacing
   the Zed/KasmVNC webapp: streaming a desktop GUI was the poor fit
   (separate basic auth, one instance, no per-folder URLs, launcher
   container). The editor is same-origin-proxied through cybermole behind
   the session gate (§8). openvscode-server is ruled out — unmaintained
   upstream.

## 2. Data model (state db, `user_version` 6)

```sql
CREATE TABLE IF NOT EXISTS apps (
  id         TEXT PRIMARY KEY,        -- uuid v4 (crypto.randomUUID) → AppId
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,    -- [a-z0-9][a-z0-9-]{0,39}
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,        -- epoch ms
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,           -- username; single-user login today
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,        -- uuid v4 → WorkspaceId
  app_id     TEXT REFERENCES apps(id) ON DELETE CASCADE,  -- NULL = console
  name       TEXT NOT NULL,           -- free text, sidebar label
  cwd        TEXT NOT NULL,           -- terminal spawn dir + editor folder
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspaces_by_app ON workspaces (app_id, sort_order);

CREATE TABLE IF NOT EXISTS terminals (
  id           TEXT PRIMARY KEY,      -- uuid v4 → TerminalId
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT,                  -- NULL → UI labels "term N"
  sort_order   INTEGER NOT NULL,      -- tab order; append = max+10
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  updated_by   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terminals_by_workspace ON terminals (workspace_id, sort_order);
```

Jobs changes (same version bump):

```sql
ALTER TABLE jobs ADD COLUMN app_id TEXT REFERENCES apps(id) ON DELETE SET NULL;
-- a job is TAGGED with an app, never owned by one: deleting an app
-- un-tags its jobs, never deletes them.
ALTER TABLE job_runs ADD COLUMN log        TEXT;      -- log file path, NULL pre-v6 runs
ALTER TABLE job_runs ADD COLUMN exit_code  INTEGER;   -- filled when the finish is observed
ALTER TABLE job_runs ADD COLUMN finished_at INTEGER;  -- ditto
```

The `sessions` overlay table is dropped — but **only in branch 4**
(`task/ws-console`), when the code that reads it dies with it (§11):
`SCHEMA` loses its CREATE and
gains an idempotent `DROP TABLE IF EXISTS sessions;` (runs at every open,
no version bookkeeping). Shipping the drop earlier 500s every
`/api/state` poll: `consoleState()` still reads `hiddenIds()` from that
table and fails closed.

Notes:

- **Upgrade mechanics.** The existing pattern in `StateDb.db()` is
  `exec(SCHEMA)` + a version bump — there is no ALTER mechanism, and
  `ALTER TABLE ADD COLUMN` is *not* idempotent (verified: second run →
  `duplicate column name`). So: `SCHEMA`'s CREATEs carry the NEW shape
  (fresh dbs — including every e2e `global-setup` db, which starts at
  `user_version 0` — get the new columns at CREATE), and each ALTER for
  pre-v6 dbs is guarded by a column-existence check via
  `PRAGMA table_info` (not by the version number: a v0 db must pass
  create-then-skip). The `> 6` future-version guard is retained. The
  Kysely `StateSchema` block in db.ts stays in step with SCHEMA (new
  tables, the `jobs`/`job_runs` columns; `SessionsTable` goes with the
  DROP).
- **Foreign keys**: `node:sqlite` opens with `PRAGMA foreign_keys = 1`
  by default (verified: cascades fire) — but the plan requires setting it
  explicitly next to `busy_timeout`, so the cascade/un-tag semantics
  never rest on a Node default.
- **Constraint violations → error codes** without message-sniffing
  (CODE_STYLE §2): pre-check-then-insert (SELECT the slug / the parent
  app row first) and let the residual TOCTOU race degrade to
  `database_error`.
- uuid v4, not v7: matches the repo's existing id minting
  (`crypto.randomUUID` for upload keys); ordering never relies on the id —
  `sort_order` (+ `created_at` tiebreak) is explicit.
- Order allocation in steps of 10; a reorder that runs out of gap
  rewrites the sibling set. v1 ships no reorder UI; the columns are the
  future-UI hook.
- App delete: rows cascade (workspaces → terminals) and the server
  best-effort-kills the deleted terminals' tmux sessions. Job rows are
  untouched (`SET NULL`). Workspace delete: same shape.
- `created_by`/`updated_by` source: the username of the single
  `credential` row, read through services (locals carry only the session
  token today).

## 3. Domains, brands, schemas

- `src/types/branded.ts`: add `AppId`, `WorkspaceId`, `TerminalId`
  (Brand<string, …> + `as*()` casts for the db, a trusted source).
  `PiSessionId` is removed **in branch 4** (its last user,
  hidden-sessions, dies with §11).
- `src/schemas/patterns.ts`: ADD `APP_SLUG_RE`, `UUID_RE` (lowercase v4,
  like `OBJECT_KEY_RE`'s shape but bare) and the app-slug normalizer (the
  old slugifier renamed `normalizeSlug`, capped at 40). REMOVE
  `SESSION_ID_RE`, `normalizeSessionName` **in branch 4** — `/api/new`
  imports the latter today.
- `src/schemas/ids.ts`: ADD `AppIdSchema`, `WorkspaceIdSchema`,
  `TerminalIdSchema`, `AppSlugSchema` (regex + brand), for path params
  and bodies. Remove `PiSessionIdSchema` in branch 4.
- `src/schemas/api.ts`: ADD the bodies in §6 (branch 1). REPLACE
  `newSessionBody`/`hideBody`/`unhideBody` **in branch 4** with the
  routes that import them. Job save schema gains optional `appId`.
- **Wiring (CODE_STYLE §6)**: the domains live in `src/lib/apps.ts` +
  `src/lib/workspaces.ts` (terminals live there — they are meaningless
  outside a workspace), are constructed ONCE in `server/main.ts`, exposed
  on `CybermoleServices`, and reached by routes only via
  `locals.cybermole` — never runtime-imported by Astro code (Vite would
  bundle a second `StateDb`/domain copy). `services.ts` gains the
  members; `ServiceDeps` gains what they need (stateDb, tmux access,
  `cfg`, `sessionEnv`).
- Result families with closed error codes, per `docs/CODE_STYLE.md` §1:
  - `save_app`: `invalid_name | duplicate_slug | database_error`
  - `delete_app`: `app_not_found | database_error` (+ tmux kill is
    best-effort, logged, never fails the delete)
  - `save_workspace`: `invalid_name | invalid_cwd | app_not_found | database_error`
  - `delete_workspace`: `workspace_not_found | database_error`
  - `new_terminal`: `workspace_not_found | server_not_running |
    tmux_error | database_error` — the row is created even when the tmux
    spawn fails (§4); `tmux_error` still reports, the UI shows a dead tab
  - `close_terminal`: `terminal_not_found | database_error`
  - `rename_terminal`: `terminal_not_found | database_error`
  - `terminalForAttach(id)`: `terminal_not_found | database_error` —
    used by `server/main.ts`'s WS path (row + workspace cwd)
- HTTP statuses mapped only in `src/lib/web/responses.service.ts` (§6).
- `workspaces.ts` also owns the tree read behind `GET /api/state` and
  the `live` diff (§5).

## 4. Terminal ↔ tmux lifecycle

- tmux session name is **derived, never stored**: `t-<uuid>` (38 chars,
  charset fits `TMUX_SESSION_NAME_RE` — same trick as today's `r-<uuid>`).
  A `terminalSessionName(id)` helper in `tmux.ts` replaces
  `resumeSessionName` (deleted).
- **Create** (`new_terminal`): insert row (sort_order = max+10) →
  best-effort `tmux new-session -d -s t-<uuid> -c <workspace.cwd>` with
  today's `sessionEnv` and `CYBERMOLE_COMMAND` argv. The row exists even
  when the spawn fails (split shape: workspace container down) — the tab
  renders as not-live and the first attach retries the spawn. Rows never
  block on tmux; **no eager spawns at server boot**.
- **Attach** (WS, `server/main.ts`): resolve the row → derive the name →
  never-fork guard → if `hasSession` is false, respawn at the workspace
  cwd (same env/command) → `attach -d`. This is the honest limit of
  "terminals survive restarts": tmux surviving (web restart, the common
  case) = content survives; tmux dying (workspace container loss) = tabs
  and structure survive, content respawns fresh at the cwd.
- **Close tab** = best-effort `tmux kill-session` + delete row. No
  graveyard, no history in v1.
- **Live flags**: `GET /api/state` diffs `tmux listSessions()` names
  against terminal rows (`t-<uuid>` present = live). The 15 s poll
  feeds per-tab dots.
- One tmux **session** per tab, not windows-in-a-session: the attach
  model stays 1 WS = 1 session, and tmux's active-window is session
  state — two browser tabs on two windows of one session would fight.
- Default terminal command: `$SHELL -l` when `SHELL` is set, else
  `/bin/sh -l`; whitespace-split like today's `CYBERMOLE_COMMAND` (in
  `env.ts`, replacing the vendored-pi default). `sessionEnv`
  (`PI_CODING_AGENT_DIR` etc.) is unchanged and keeps a manually-run pi
  on the controlled agent dir.

## 5. `GET /api/state` — the workspace tree

`services.consoleState()` becomes:

```jsonc
{
  "me": "ok",
  "configured": true,
  "editor": true,                  // CYBERMOLE_EDITOR_UPSTREAM set? same-origin ${BASE}/editor/;
                                   // false hides the editor tab (§8)
  "defaultCwd": "/workspace",      // CYBERMOLE_NEW_SESSION_CWD, prefills the dialog
  "apps": [ { "id": "…", "name": "…", "slug": "…", "order": 10 } ],
  "workspaces": [                   // flat; the client groups by appId
    {
      "id": "…", "appId": null, "name": "scratch", "cwd": "/workspace",
      "order": 10,
      "terminals": [ { "id": "…", "title": null, "order": 10, "live": true } ]
    }
  ]
}
```

Flat-with-`appId` keeps the server read one query per table; grouping
(console group first, then apps by order) is client-side in the sidebar.
The pi-session scan, `hiddenCount`, and the live list are gone. The
shape switch lands in branch 4 (`task/ws-console`, §13).

## 6. HTTP API

Thin Astro routes, parse → one service call → response (CODE_STYLE §6):

| Route | Body | Notes |
|---|---|---|
| `POST /api/apps` | `{name}` | slug derived (`normalizeSlug`); `duplicate_slug` → 409 |
| `PATCH /api/apps/:slug` | `{name?}` | slug stable once created (v1) |
| `DELETE /api/apps/:slug` | — | cascades + tmux kills; jobs un-tagged |
| `POST /api/workspaces` | `{appId?: string\|null, name, cwd?}` | cwd defaults to `CYBERMOLE_NEW_SESSION_CWD`; validated absolute + existing dir (like `zed.ts` does) |
| `PATCH /api/workspaces/:id` | `{name?, cwd?}` | |
| `DELETE /api/workspaces/:id` | — | kills terminals' sessions, cascades |
| `POST /api/workspaces/:id/terminals` | `{title?}` | §4 create; returns the row + `live` |
| `PATCH /api/terminals/:id` | `{title?}` | tab rename |
| `DELETE /api/terminals/:id` | — | close tab |
| `GET /api/jobs/:name/runs` | — | `{ runs: [{ firedAt, origin, exitCode, finishedAt, hasLog }] }`, newest first |
| `GET /api/jobs/:name/runs/:fired_at/log` | — | text/plain; the run's log tail (≤1 MiB); `:fired_at` is an integer epoch-ms path param (schema-validated like every other param); the path is built server-side from the row, never from client input |

Deleted: `POST /api/new`, `POST /api/session/hide`, `POST
/api/session/unhide`, `GET /api/state`'s old shape, and `POST
/api/zed/open` — with **no successor route**: the editor is served by
`server/main.ts`'s own proxy (§8), and a folder opens via the iframe
URL's `?folder=` param, not a server call.

## 7. WS protocol (`src/schemas/frames.ts`, `server/main.ts`)

- Client frames: `{type:'attach', mode:'terminal', id}` (uuid → respawn
  if dead, §4) and `{type:'attach', mode:'run', target}` (a live job
  run's tmux session name — never respawns; replaces today's `live` mode
  for the jobs "view run" path). `input`/`resize` unchanged. The
  `resume` mode is deleted.
- **Reconnect keeps its mode.** Today `agent-terminal.reconnect()` is
  hardcoded to `mode:'live'` with the last tmux name. Under the new
  model the client must remember *what it attached to* (terminal id vs
  run target) and reconnect with the same frame — a terminal tab whose
  session died mid-drop then gets the §4 respawn instead of
  `no such live session`, and a `run` attach never morphs into a
  respawn. Without this, the restart-survival story is false.
- Server frames unchanged (`attached` carries the tmux name, as today).
- `ActiveKey` becomes `` `terminal:${TerminalId}` | `run:${TmuxSessionName}` ``
  — **in branch 4**. Branch 2 *grows* the union additively (the old
  `live:`/`resume:` variants stay) so the old UI keeps compiling.
- Deep links: `/?t=<terminal uuid>` replaces `/?live=<name>`; the jobs
  page's "view run" links to `/?run=<session name>`.
- The never-fork guard, `attach -d`, ping keepalive, logout/shutdown
  socket handling are untouched.

## 8. Console UI

- **Sidebar** (`session-sidebar.ts` → `workspace-sidebar.ts`): groups —
  "Console" (appId null) first, then each app by `sort_order`; workspace
  rows (name + live-terminal count badge); filter input on workspace
  name; `+ workspace` in each group header; `+ app` at the bottom.
  Emits `select-workspace {id}`, `new-workspace {appId}`, `new-app`.
  Keeps the innerHTML-poll + state-preservation discipline for the
  filter input (AGENTS.md).
- **Main pane**: selected workspace → a new light-DOM `<terminal-tabs>`
  component: terminal tabs in order (title || "term N", live dot, close
  button) · `[+]` secondary button on the right · editor tab pinned last.
  Selecting a tab shows that terminal's `<agent-terminal>` — one live
  instance per tab, hidden tabs keep their WS attached (state and
  scrollback persist, matching how tmux detach works today). The known
  costs of many instances are handled explicitly:
    - **WebGL**: the addon is lazy-loaded on a tab's *first activation*
      (browsers cap live WebGL contexts — roughly 8–16 in Chromium;
      past that the oldest context is lost and that terminal corrupts).
      A never-activated tab never loads one.
    - **0×0 resizes**: hiding a tab (`display:none`) fires the
      ResizeObserver at 0×0 — `fit()` is skipped when either dimension
      is 0, and re-showing refits + re-sends the size.
    - Per-instance `window`/`document` listeners (online/visibility)
      were designed for a singleton — moved to a shared manager or
      guarded.
  `+` creates a terminal (POST, then focus the new tab).
- **Editor tab** (VSCodium reh-web):
    - compose `editor` service, opt-in profile (like today's `zed`):
      a thin in-repo image (the `zed/` precedent) running the **pinned**
      `vscodium-reh-web-linux-x64-<version>.tar.gz` (lowercase — the
      release asset name) as uid 2000 / gid 2001 (linuxserver's
      `docker-vscodium-web` is the off-the-shelf alternative — the same
      reh-web component), mounting `cybermole-workspace` at the same
      `/workspace` path (path agreement, like the tmux split), umask
      0007, PLUS a persistent `cybermole-editor-home` volume for
      VSCodium's user-data/extensions with an init chown (the
      `cybermole-zed-home`/`zed-init` precedent — empty named volumes start
      root-owned and uid 2000 must write `$HOME`).
    - entrypoint: the tarball's server binary (`bin/codium-server`;
      `codium serve-web` is the desktop CLI's door to the same
      component) with `--host 0.0.0.0 --port 3000 --server-base-path
      ${CYBERMOLE_BASE%/}/editor --without-connection-token` — auth is
      upstream (cybermole's session gate); the base path matches the proxy
      so asset URLs line up (`CYBERMOLE_BASE` interpolates into the
      service like the cybermole service's). The exact entrypoint name and
      the `?folder=` param shape (plain path vs URI-encoded) are PINNED
      BY THE SPIKE, not assumed.
    - `server/main.ts` reverse-proxies `${BASE}/editor/*` → the upstream
      (HTTP + WebSocket), behind the existing origin check + session
      gate. Same-origin iframe: auth = the existing session cookie, no
      cross-origin cookies, no basic-auth prompts (round-1 finding 8's
      risk class dies). But "no header changes" is FALSE — the app's
      `SECURITY_HEADERS` ride on EVERY response via `hardenResponse`:
    - **editor routes carry their own header set** (the override
      mechanism exists — `hardenResponse` keeps handler-set headers):
      `frame-ancestors 'self'` and no `X-Frame-Options: DENY` on editor
      HTML — the editor response's frame-ancestors governs OUR page
      framing IT, so the global `'none'` kills the iframe on arrival —
      plus a CSP that fits VS Code web: `worker-src 'self' blob:`,
      `img-src 'self' data: blob:` (the workbench's blob workers and
      data images — `script-src 'self'` alone blocks them via
      fallback), and a deliberate allow/deny on marketplace
      `connect-src` (Open VSX). Exact list finalized by the spike
      against a real browser.
    - **service-worker bypass**: `sw.js`'s fetch handler must skip
      `editor/` the way it skips `api/`/`partials/` — else
      stale-while-revalidate serves MIXED-VERSION workbench assets
      after an editor upgrade (VS Code's asset paths are unhashed; the
      classic blank-editor failure), authenticated editor content
      stays cached beyond logout, and the offline shell renders inside
      the iframe.
    - the editor tab is an iframe of
      `${BASE}/editor/?folder=<workspace.cwd>` — a folder opens by URL,
      no launcher container, no POST, no token file. One editor server,
      many folders: each tab/window opens its own `?folder=` — the
      one-Zed-instance limit is gone.
    - proxy pipeline specifics (all deliberate, in `main.ts`): response
      STREAMING (the JS bundles are MBs — no buffering); a body-cap
      entry that ALSO accepts length-less/chunked bodies (the 411
      path) and swaps the 5-minute body deadline for the upload route's
      stall-guard treatment — sized to the largest file a user might
      save through the editor, not "a few MiB for settings"; the
      editor's WebSockets get a NEW prefix branch in the `upgrade`
      handler, before the `/ws` equality check — gates that apply:
      `shuttingDown`, Origin (same-origin passes), the session gate;
      NOT the terminal `wsLimiter` (VS Code opens several per window;
      30/min/IP would throttle two tabs); the socket is a RAW WS proxy
      (never `wss`/`attach` — no pty) AND is tracked per token, so
      logout / "log out everywhere" cut editor shells too — they are
      another shell as uid 2000 and the 30-s guarantee must hold; add
      `editor/` to `quietAccessPath` (an IDE's worth of asset traffic
      at http level would bury the console).
    - **the spike decides primary vs fallback** (branch 3's first
      task): base-path under a reverse proxy has open upstream issues
      (microsoft/vscode#208278 — WebSocket subpath breakage), so treat
      same-origin-under-base-path as the CANDIDATE: verify framing,
      the header set, the integrated terminal as uid 2000, and
      `?folder=` in a real browser (the AGENTS.md login-page lesson),
      and fall back to cross-origin subdomain + `--connection-token`
      (`?tkn=` in the iframe URL, CSP `frame-src`) — still promptless —
      if it fights.
    - dev: `astro.config.mjs`'s dev proxy gains the `editor` entry.
    - security: the editor's integrated terminal is another web shell as
      uid 2000, behind the session gate — same blast radius as the
      terminals ("the terminal is the product"). VSCodium is the
      telemetry-free build (Open VSX by default), matching the stack's
      no-phoning-home stance; pin the release like every vendored dep.
  - Empty state (no workspace selected): a prompt to create one.
- **Dialogs** (owned by `<console-app>`, outside the polled sidebar):
  new app (name), new workspace (name + cwd, prefilled from
  `state.defaultCwd`), delete confirmations. Forms per AGENTS.md
  (validation-enhancer-zod, WaField hints).
- `<app-header>` is unchanged (Console is `/`; settings/jobs links stay).
- Tab bar updates must be granular (per-tab status dot flips), not
  innerHTML swaps of the whole bar — the AGENTS.md sidebar caveat, and
  `agent-terminal`'s ResizeObserver needs the box to stay resizable.

## 9. Jobs: app tag + persisted logs + run viewing

- `jobs.app_id` (nullable): the save schema/route/dialog gain an
  optional app picker; the jobs list shows the tag chip — `listJobs`
  LEFT JOINs `apps` and carries `{appId, appName}` per job (the page
  makes no second fetch). No behavioral coupling — cwd/env stay global,
  runs stay `cybermole-<name>` sessions.
- **Run logs**: the fire wraps the command — the user command is passed
  as **argv to an inner shell**, never string-embedded (`{ <command>; }`
  breaks on a `#` comment; and NO pipefail: dash rejects `set -o
  pipefail`, and without it `$?` after `cmd | tee` is TEE'S — the exit
  file would record success for failed runs, worse than unknown). The
  exit code is captured INSIDE the pipeline, before tee:

  ```js
  // jobs.ts builds argv, not a composed string:
  ['/bin/sh', '-c',
   'mkdir -p "$(dirname "$2")"; { /bin/sh -c "$1" 2>&1; echo $? > "$3"; } | tee "$2"',
   'sh', /* $1 */ row.command, /* $2 */ logPath, /* $3 */ exitPath]
  ```

  — pure POSIX (no shell-feature lottery), the live tmux view still
  shows output AND a durable log exists; the wrapper's own exit status
  is tee's (0) — irrelevant, the code is read from the file. The log
  dir is created by the wrapper itself (a failed mkdir/tee must not
  kill the run — output is lost, the exit file is missing, the run's
  result stays 'unknown').
- **Log location**: under the WORKSPACE volume, not the state dir — the
  wrapper runs as uid 2000 in the workspace container, where
  `CYBERMOLE_STATE_DIR` is not even mounted (compose split), so a
  state-dir placement silently no-ops the whole feature in the
  flagship deployment. Pin `/workspace/.cybermole/job-logs/<job>/…`: the
  parent created by `workspace-init` as `workspace:cybermole`, mode 2770
  (setgid + group write; umask 0007 below it), so the web uid can read
  (the `GET …/log` route) and unlink (pruning) everything under it.
- The tick's existing run-finish observation (session left the live set)
  additionally reads the exit file → fills `exit_code` + `finished_at`,
  and `lastResult` finally reports success/failed (unknown when the
  file is missing).
- **Log pruning rides the existing `RUN_HISTORY` (20) pruning** — which
  must SELECT the doomed rows' `log` paths *before* the DELETE (paths
  are gone after), unlink the files, then delete the rows.
- No log size cap in v1 — noted accepted risk; a truncating wrapper can
  come later.
- **Viewing**: the jobs page gains, per job, an expandable run history
  (fired_at, origin, duration, exit) with a log viewer for the tail
  (`GET …/log`). A **live** run gets "view" → console deep link
  `/?run=cybermole-<name>` → terminal attach in `run` mode. This replaces
  the dropped Live section's run visibility.

## 10. Env / settings surface

- `CYBERMOLE_COMMAND`: default becomes `$SHELL -l` (fallback `/bin/sh -l`);
  docs re-label it "command a new terminal tab runs". (Name kept to
  limit churn; renaming to `CYBERMOLE_TERMINAL_COMMAND` is a docs-only
  option while greenfield.)
- `CYBERMOLE_NEW_SESSION_CWD`: demotes to the default cwd pre-filled in the
  new-workspace dialog (and the fallback when a POST omits `cwd`).
- `/settings` dashboard: label updates only (command shown is the shell;
  `newSessionCwd` → "default workspace cwd"). The "sessions dir" row and
  `CYBERMOLE_SESSIONS_DIR` die with the pi-session scan (§11).
- The Zed env contract — `CYBERMOLE_ZED_URL` / `CYBERMOLE_ZED_LAUNCH_URL` /
  `CYBERMOLE_ZED_LAUNCH_TOKEN` (three vars, half-set boot validation,
  zed-init's generated token file) — is **replaced by one**:
  `CYBERMOLE_EDITOR_UPSTREAM` (e.g. `http://editor:3000`; unset = editor
  off). No token, no launcher URL: auth is the web session, folders are
  URL params.
- e2e's deterministic `cmd.sh` keeps working as `CYBERMOLE_COMMAND`.

## 11. Deletions (greenfield — remove, don't deprecate; the Zed
integration dies in branch 3 `task/ws-editor`, everything else in branch
4 `task/ws-console`)

Core list:

- `src/lib/sessions.ts` (pi store scan + title cache),
  `src/lib/hidden-sessions.ts`, the `sessions` table (§2 — SCHEMA loses
  its CREATE, gains `DROP TABLE IF EXISTS`).
- `POST /api/new`, `/api/session/*`, their schemas (`newSessionBody`,
  `hideBody`, `unhideBody`), `SESSION_ID_RE`, `normalizeSessionName`,
  `PiSessionId` + `PiSessionIdSchema`.
- WS `resume` attach path (main.ts), `resumeSessionName` **and**
  `resumeSession` (tmux.ts).
- The Live list UI, `?live=` deep link, `ActiveKey live:`/`resume:`.
- `findSession`-based cwd resolution (the workspace row owns cwd now).
- `listSessions`'s cwd/attached fields (their only consumer was the Live
  list + its Zed button) — it becomes a name-set source; `liveSessionNames`
  already covers the need.
- The **Zed webapp integration, wholesale** (replaced by §8's editor):
  `zed/` (Dockerfile, entrypoint, `kasmvnc.yaml`, `zed-launcher.py`),
  compose's `zed` + `zed-init` services and the `cybermole-zed-credentials`
  volume, `src/lib/zed.ts`, `POST /api/zed/open` + `zedOpenBody`,
  `readZedConfig` (env.ts / env-schema.ts), the `openInZed` service
  member, `ConsoleState.zed`, `zedOpenFailureResponse`
  (responses.service.ts), `tests/unit/zed.test.mjs`, the sidebar's Zed
  buttons and `<console-app>`'s `open-zed` listener/`launchZed`
  (retargeted to `window.open` of the editor URL in the SAME branch),
  the e2e `/api/state` `zed === null` assertion (retargeted to the
  editor), and `docs/zed-webapp.md` (superseded by
  `docs/editor-webapp.md`).

The
closure (everything else that dangles once the above go — sweep with
`grep -r 'sessionsDir\|hiddenSessions\|PiSessionId\|resumeSession\|SESSION_ID_RE'`
and `grep -ri zed` for the editor swap):

- `tests/split.spec.ts` — drives `POST /api/new` (the never-fork 503
  spec) and WS `resume`; **retarget** at `POST
  /api/workspaces/:id/terminals` + the `terminal` WS mode (it is the
  only e2e covering the never-fork guard on the spawn path).
- Unit files importing deleted exports — rewrite with the deletions:
  `api.test.mjs` (`newSessionBody`/`hideBody`/`unhideBody`),
  `ids.test.mjs` (`SESSION_ID_RE`/`PiSessionIdSchema`),
  `tmux.test.mjs` (`resumeSession*`), plus delete
  `hidden-sessions.test.mjs`.
- `CYBERMOLE_SESSIONS_DIR` (env-schema.ts + env.ts), `cfg.sessionsDir`
  (services.ts), the /settings "sessions dir" row (SettingsView.astro).
- `services.ts`: `hiddenSessions` dep + member; the `newSession` service
  method.
- `src/lib/web/responses.service.ts`: `tmuxSessionFailureResponse` (sole
  caller was `/api/new`) — or retarget it at the new terminal family.
- `db.ts`: `SessionsTable` + the StateSchema entry.
- e2e fixtures that manufacture pi sessions (`tests/env.ts`
  `UUIDV7_SIBLINGS`, `tests/global-setup.ts` fixture sessions) — replaced
  by workspace/terminal fixtures.
- `tests/sessions-cache.spec.ts` and the e2e session-sidebar/hide/
  resume/live specs (§12 replaces them).

## 12. Tests

- Unit (per Result family, per error code — CODE_STYLE §9):
  `apps.test.mjs`, `workspaces.test.mjs` (terminal create/attach-lookup/
  close, tree read + live diff), slug normalization, `frames.test.mjs`
  for the new attach modes, scheduler finish-observation with exit
  files, the argv wrapper construction (pure), db v6 upgrade (v5 file →
  v6 with ALTERs applied; fresh v0 file → new shape, no ALTER throws).
- e2e (rewrite of the console specs around the new flows):
  - create app → create workspace (cwd default) → new terminal → tab
    appears live → input round-trips; close tab kills the session.
  - terminal survives a web restart — **spawned-child pattern**: the
    spec boots its own server on a spare port with its own db copy (the
    jobs-persist precedent), never SIGTERMs the shared webServer, and
    signs in outside the shared login budget. The rate-limit test stays
    last.
  - dead-tab respawn: kill the tmux session out-of-band → poll shows
    not-live → attach respawns at the workspace cwd.
  - sidebar grouping + name filter + poll state preservation.
  - jobs: save with app tag, run now, log file appears, run history +
    log view render, live run view via `/?run=`.
  - malformed bodies on the new routes (400s), oversized body cap, WS
    junk frames — keep the existing abuse specs, retargeted.
  - Editor: unit-test the proxy gating (unconfigured → 404, path
    handling under `/editor/`, WS upgrade routing, body-cap/deadline
    exemption, per-token socket tracking) and the editor-route header
    set (extract a builder: `frame-ancestors 'self'`, no XFO, the
    worker/img CSP of §8); unit-test the SW bypass (`sw.js` skips
    `editor/`); e2e retargets the "webapp absent when unconfigured"
    spec from Zed to the editor (`/api/state`'s `zed === null`
    assertion → editor absent).
- Login-budget rule stays: `login()` once, serial tests.

## 13. Build order (task/* branches, one at a time, each green)

1. **task/ws-schema** — **additive only**: db v6 (new tables +
   table_info-guarded ALTERs; `sessions` untouched), new brands /
   patterns / ids / api schemas ADDED (nothing removed), the
   `apps.ts`/`workspaces.ts` domains wired through `CybermoleServices` +
   their CRUD routes + unit tests. `/api/state` still serves the old
   shape. `npm run check`, units, and e2e all stay green.
2. **task/ws-terminal** — WS `terminal`/`run` attach modes + respawn +
   mode-aware reconnect, `terminalSessionName`, terminal create/close
   routes wired to spawns, `agent-terminal` updates. `ActiveKey` GROWS
   (old variants kept); old modes still work; UI not switched.
3. **task/ws-editor** — the editor swap: compose `editor` service (thin
   in-repo image, pinned reh-web tarball, home volume + init chown),
   the `main.ts` same-origin proxy behind the gate (streaming, WS
   routing + per-token tracking, body-cap/deadline exemption, editor
   header set, SW bypass, quiet-path), `CYBERMOLE_EDITOR_UPSTREAM`, the
   astro dev-proxy entry, and the §11 Zed-integration deletions — with
   today's "open in Zed" affordances retargeted to `window.open` of
   the editor URL (the tab UI comes with branch 4). **The spike decides
   primary vs fallback FIRST** (§8) — round-2 review concentrated here;
   treat §8's checklist as this branch's definition of done.
   Independently shippable and testable.
4. **task/ws-console** — the UI rewrite: workspace sidebar, terminal
   tabs + `+` + editor tab (consuming branch 3), dialogs, the new
   `/api/state` shape switched on, deep links — AND all of §11's other
   deletions + the `sessions` DROP (they die together with the UI that
   used them) + the `ActiveKey` swap.
5. **task/ws-jobs** — `app_id` tag, log wrapper + run-history routes,
   jobs page UI (tag picker, history, log viewer, live-run deep link).
6. **task/ws-docs** — README, `docs/`, TODO.md refresh, this plan's
   status → shipped.

## 14. Out of scope (explicitly, for later)

- Tab drag-reorder and workspace/app reorder UI (columns exist).
- Per-workspace terminal command overrides; workspace templates
  (pre-seeded terminals); per-app cwd; app icons.
- Editor extension/marketplace configuration beyond the VSCodium
  defaults (Open VSX, no telemetry); curated per-app extension sets.
- pi-session resume as an *action inside* a workspace ("resume a past
  agent session into a new terminal tab") — the scan code is deleted;
  if wanted later it returns as a workspace-scoped affordance.
- Log size caps / rotation; job exit-code notification hooks.
