# pi/ — the controlled pi agent-dir template

Everything in this directory is seeded into the **runtime agent dir**
(default `<app root>/.pi-agent`, or `CYBERMOLE_AGENT_DIR`) at server boot,
**only where the runtime dir doesn't already have the file** — existing
files always win, so config pi itself writes (settings.json) or the
operator customises is never clobbered, while template files added by
upgrades still land. Files only pi itself writes (`auth.json`,
`sessions/`, caches, …) are never in the template.

Spawned pi sessions get `PI_CODING_AGENT_DIR=<runtime dir>` — they never
read or write `~/.pi/agent`. Credentials therefore live per-install:
`/login` once inside a cybermole session, or seed `auth.json` yourself.

Layout mirrors pi's agent directory (`pi docs: configuration.md`):

| Path                    | Purpose                                  |
|-------------------------|------------------------------------------|
| `settings.json`         | pi settings (docs: settings.md)          |
| `mcp.json`              | MCP servers every session can use        |
| `models.json`           | compatible endpoints / model overrides   |
| `AGENTS.md`             | user instructions applied across cwds    |
| `SYSTEM.md` / `APPEND_SYSTEM.md` | replace / extend the system prompt |
| `keybindings.json`      | custom TUI keybindings                   |
| `extensions/`           | extensions shipped to every session      |
| `skills/`               | skills shipped to every session          |
| `prompts/`              | prompt templates (slash commands)        |
| `themes/`               | custom themes                            |

Project-level config (`.pi/` in a session's cwd) still applies on top of
this, per pi's normal precedence — trust prompts included.

## The jobs MCP server

`mcp.json` registers **cybermole-jobs** — the jobs surface as in-session
MCP tools (docs/plans/jobs-agent-plan.md §6): a stdio server
(`dist-server/server/mcp.js`, spawned per session) whose tools are 1:1
with the internal jobs API's verbs — `jobs_list`, `jobs_create`,
`jobs_set`, `jobs_delete`, `jobs_runs`, `jobs_log`, `jobs_run_now`,
`jobs_kill`, `jobs_validate`, plus `apps_list` (the create form's
app-tag picker is a user action too). Every session starts with them
(`exposure: "direct"` — a small, frequently used tool set), and every
tool result carries the internal API's Result JSON verbatim, so an
agent reads the same answers the console and the CLI do — including the
failure codes (`job_not_found`, `run_not_active`, …). It needs the
internal socket: it resolves `CYBERMOLE_SOCK` exactly like the server
itself, so the compose split's default needs no entry `env` (override
`CYBERMOLE_SOCK` there only if the deployment moves the socket off the
shape default).

The command is the **absolute image path** — the entry runs in the
workspace container, and both containers ship the image at `/opt/cybermole`.
Dev shapes differ: the compose dev profile bind-mounts the checkout at
`/app` (`/app/dist-server/server/mcp.js`), and a bare host run uses the
checkout's own path. Seeding is only-where-absent, so a host that wants
a dev-shaped entry pre-seeds the runtime dir's `mcp.json` before first
boot — an existing runtime file always wins over the template.

Template updates here reach the runtime dir at the next seeding boot
and an open session only via `/reload`.

## The workspace-root AGENTS.md — a sibling one-file template

The root agent's standing instructions are NOT part of this dir: they
live in the repo's [`root-agents/AGENTS.md`](../root-agents/AGENTS.md),
seeded only-where-absent into the **default workspace cwd**
(`CYBERMOLE_NEW_SESSION_CWD` — `/workspace` in the compose split), so
app checkouts under the workspace root read them by upward walk
(docs/plans/jobs-agent-plan.md §9). Same policy, same seeder halves as this
template (the workspace entrypoint in the split, the server's boot
seeding single-user); different target — the workspace root, not the
runtime agent dir. Its content is the jobs conventions (scheduled work
belongs in jobs; a fired run is started-not-finished — check exit
codes) and the tool surface: the `cybermole-cli` CLI's verbs and the
cybermole-jobs MCP tools registered by the `mcp.json` above.

## Shipping resources to every session

- **MCP servers** — `mcp.json`:
  `{"mcpServers": {"name": {"command": "…", "args": […]}}}` (pi docs:
  mcp.md). Available in every cybermole session — only add servers whose
  credentials you're happy exposing to everything a session can do.
- **Skills** — `skills/<name>/SKILL.md` (+ supporting files), loaded by
  every session.
- **Extensions** — `extensions/*.js`, loaded as ES modules at startup.
- **Prompt templates** — `prompts/<name>.md`, exposed as slash commands.

The shipped `settings.json` sets `quietStartup: "header"` — trims pi's
boot output to the header line, suited to a browser terminal. Because
seeding is only-if-absent, tuning settings from inside a session
(`/settings`) survives restarts.
