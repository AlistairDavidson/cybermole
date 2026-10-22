# The jobs agent plan — jobs as a core feature, agent-operable

Status: **agreed** — the design discussion that produced this repositioned
the project (self-modification retired as a target; apps are the
live-modifiable unit, in a future epic; jobs are core). This doc specs the
first epic built on that positioning. Branches: §10.

## 0. Positioning (locked)

- **The core webapp is an appliance.** Unmodifiable from within, by
  construction. It changes the normal way: edit on the host → build the
  image → `docker compose up -d`. Nothing inside a container (human or
  agent) swaps what the web container serves.
- **Apps are the part users live-modify.** That build-out is its own
  future epic; nothing in this plan depends on it, and this plan grows no
  per-app machinery (no app deploy/rollback/migration features — an app's
  lifecycle is its own business, driven by its own jobs and git).
- **Jobs are a core feature, not an app.** Global, optionally tagged with
  an app, exactly as shipped.
- **v1 trust: one root-level agent.** The console agent manages jobs;
  per-app agent access is future work (§2).

## 1. Retire self-modification

Remove, outright:

- `/management` (page, `ManagementView.astro`, `management-app.ts`,
  partials) and `src/pages/api/management/*` (commits, build, activate,
  preview).
- `src/lib/releases.ts` and everything only it used (incl. the password
  re-verification helper if `/management` was its only caller — verify in
  the task; `webpi-set-password` stays).
- compose: the `builder` and `releases-init` services, the
  `webpi-releases` volume, and the dev-profile references.
- env knobs `WEB_PI_RELEASES_DIR`, `WEB_PI_MANAGEMENT_CHECKOUT`
  (README env table, env-schema, entrypoint loading).
- `docs/management-page.md` (superseded), the README `/management`
  sections, DESIGN_REVIEW threat-model paragraphs about the protected set
  / dry-run enforcement, and the related unit + e2e specs.

Stays untouched: `/settings` (the status surface), the vendored-pi update
button + opt-in auto-update (a *dependency* update, not self-modification),
the credential/login machinery, the tmux/jobs/files/editor surfaces.

The split's promise simplifies accordingly: web serves root-owned code and
owns its state; the workspace uid owns everything it can touch. No more
"…except the one page that swaps the server" carve-out.

## 2. The trust boundary (locked)

- Creating a job is arbitrary shell as uid 2000. The workspace side
  already has arbitrary shell as uid 2000. **Full jobs control over the
  internal API is therefore zero privilege escalation** — grant it whole;
  no read-only tier, no app-scoped enforcement in v1.
- The boundary is the container + the linux user (the existing split):
  the state db is web-only, the workspace tree is workspace-owned, and
  the new socket's file mode is the only auth (§3). Nothing
  network-reachable gains a new surface.
- All terminals share uid 2000, so "only the root agent manages jobs" is
  a **usage convention** in v1 — the human chooses which terminal hosts
  the trusted agent. Real per-agent separation (per-app uids / separate
  sockets) belongs to the apps epic, explicitly not here.

## 3. The internal socket (transport)

- A second HTTP listener on a **unix domain socket**, served by the same
  Node process (`server/main.ts`), JSON only. Same-origin by being local;
  nginx / the TLS proxy never see it.
- Paths, mirroring the `WEB_PI_TMUX_SOCKET` convention: compose —
  `/run/web-pi/webpi.sock` (the shared setgid-group-`webpi` dir the tmux
  socket already lives in — the two web↔workspace IPC surfaces side by
  side); plain host — `<state dir>/webpi.sock`.
- Created `0660` group `webpi` (explicit chmod after listen — the tmux
  0600-umask dance, server-side); a stale socket file is removed at boot
  like the workspace entrypoint does for tmux. **Amended in integration:**
  a socket a LIVE server answers on no longer fails the boot — the
  instance serves on with the listener disabled and a loud boot line
  (`InternalSocketOwnedError`, main.ts degrades on exactly that marker).
  Two servers sharing one state dir (dev box, tests) is a real shape, and
  the web app must not die over an auxiliary IPC listener; every other
  start failure still stops the boot.
- Env: `WEB_PI_SOCK` — absolute path override; unset = the default for
  the shape; **empty = the listener is off** (CLI/MCP then fail with a
  clear "internal API disabled" error). A set-but-crazy value stops the
  server at boot, like the S3/editor vars.

## 4. The internal API

Verbs mirror the cookie-gated `/api/jobs` family **and return the same
Result JSON** (same closed error codes — `src/types/result.ts` families):

```
GET    /jobs                      (?app=slug filter)
POST   /jobs                      create
POST   /jobs/validate             cron + command validation
PATCH  /jobs/:name                set schedule/command/app
DELETE /jobs/:name
GET    /jobs/:name/runs
POST   /jobs/:name/run            run-now
POST   /jobs/:name/runs/:firedAt/kill
GET    /jobs/:name/runs/:firedAt/log   (tail, same 1 MiB cap)
```

Thin routes calling the `src/lib/jobs` service functions directly — no
cookie middleware, no CSRF, no rate limit (the socket *is* the gate).
The Astro `/api/jobs` routes remain the browser surface, unchanged.

Every mutation path — browser routes, internal routes, scheduler tick,
run-now — funnels through those same service functions. That single
source of truth is what keeps every surface consistent; the functions
also emit domain events (§7) so the human's page updates the moment
anything changes it, whoever changed it.

## 5. The CLI

- A third bin: `webpi` → `dist-server/cli/main.js` (alongside
  `web-pi` / `webpi-set-password`). Zero runtime deps: `node:http` with
  `socketPath`, the same Result types.
- `webpi jobs <verb>`: `list [-a app]`, `runs <name>`,
  `log <name> <firedAt>`, `create`, `set`, `delete`, `run`, `kill`,
  `validate` — options mirroring the form fields. **Parity line: every
  user action on `/jobs` has a verb.**
- Discovery: `$WEB_PI_SOCK` → `/run/web-pi/webpi.sock` →
  `<state dir>/webpi.sock`; a friendly error names the knob when off.
- `--help` is the agent-facing documentation — self-describing, no MCP
  round-trip needed to discover the surface.

## 6. The MCP server

- `webpi mcp` — a stdio MCP server subcommand of the same bin, over the
  same socket client layer as the verbs. New dependency:
  `@modelcontextprotocol/sdk`.
- Tools 1:1 with the verbs: `jobs_list`, `jobs_create`, `jobs_set`,
  `jobs_delete`, `jobs_runs`, `jobs_log`, `jobs_run_now`, `jobs_kill`,
  `jobs_validate`, plus `apps_list` (the create form's app-tag picker is a
  user action too).
- **Wiring is seeded, not configured:** the `pi/` template gains an
  `mcp.json` registering the server (absolute command path per shape),
  seeded only-where-absent into the runtime agent dir like the rest of
  the template — every pi session starts with the tools; a host that
  customized its agent config keeps its own.
- The CLI stays the substrate (works everywhere, also the MCP's debug
  surface); the MCP is the in-session convenience.

## 7. The job page — and live consistency

- `/jobs/:name`: the job's definition (schedule/command/app, with the
  edit entry), run history with exit codes and durations, the log-tail
  viewer (reused), and the live-run link (`/?run=`), server-rendered +
  `partials/jobs/<name>` like the other pages.
- **Live, not stale:** the jobs list is currently a 15 s partial poll —
  tolerable when only the human acted, confusing once agents do. The
  service layer emits domain events at its mutation/observation choke
  points — `job_created`, `job_updated`, `job_deleted`, `run_started`
  (scheduler fire or run-now), `run_finished` (exit code observed —
  when the tick sees it, not at process exit), `run_killed` — on an
  in-process bus. Every caller goes through the same functions, so
  events fire identically whoever acted.
- A cookie-gated **`/ws/events`** WebSocket forwards them — small JSON,
  `{topic: 'jobs', type, job, firedAt?}`; the topic field reserves the
  bus for later consumers (e.g. retiring the workspace sidebar's poll).
  The jobs pages subscribe and run the **same partial refresh the poll
  already runs**, debounced — one rendering path, no granular patching
  in v1. The 15 s poll stays as the safety net; the WS reconnects with
  backoff like the terminal WS.
- **Acceptance line:** a mutation over the internal socket (the agent
  path) updates an open jobs page without waiting for the poll —
  asserted in e2e. That is the "human and agent UX always show the same
  result" guarantee: one source of truth, evented.
- Human UX only. Agents read job state through §5/§6, never by scraping
  this page — that resolves the old "console that knows to interrogate
  this page" sketch.

## 8. Log caps

- **Write-time cap:** the run wrapper appends through a small bundled
  node appender (node is in the workspace container's image) that stops
  writing past `WEB_PI_JOB_LOG_MAX` (default 20 MiB), keeps draining the
  pipe, and writes a `[truncated at N bytes]` marker line. Post-run
  truncation was considered and rejected — a chatty or runaway job must
  not be able to fill the disk mid-run.
- Pruning unchanged (`RUN_HISTORY` rows + files); the 1 MiB read tail
  unchanged.

## 9. Root-agent seeding

- `/workspace/AGENTS.md`, seeded only-where-absent (the pi-template
  policy): job conventions for the root agent — scheduled work belongs in
  jobs, check exit codes before declaring success, where logs live — and
  the two surfaces (CLI verbs with examples; the MCP server, already
  wired via the template, `/reload` after template updates).
- App trees under `/workspace` make this file visible to app agents by
  upward walk — accepted (§2: same uid, convention only). If that ever
  stings, move the root agent's cwd out of `/workspace`, not the seeding
  policy.
- `pi/README.md` (the template's) points at the AGENTS.md.

## 10. Branch plan

One branch at a time (AGENTS.md fleet process; e2e by the orchestrator):

1. `task/retire-management` — §1. Independent.
2. `task/jobs-socket` — §3 + §4: listener, socket lifecycle, routes,
   units; e2e hits the socket directly (`node:http` `socketPath`).
3. `task/jobs-cli` — §5 (depends on 2).
4. `task/jobs-mcp` — §6 incl. the template `mcp.json` (depends on 2).
5. `task/jobs-page` — §7: the detail page + the events bus, the
   `/ws/events` endpoint, and the pages' subscription. Independent of
   2–4.
6. `task/job-log-caps` — §8. Independent.
7. `task/root-agents-md` — §9 + the README/TODO/DESIGN_REVIEW refresh
   that flips this header. Last.

## 11. Out of scope (explicit)

- Exit-code notifications / hooks (webhook, Grafana alerting on the Loki
  labels) — deferred; its own small fork when wanted.
- Per-app scoping or enforcement; per-app uids / separate sockets.
- The whole apps epic (lifecycle, rollbacks, migrations, per-app agents).
- Renaming, packaging, preact signals, fuzzers — untouched by this plan.
