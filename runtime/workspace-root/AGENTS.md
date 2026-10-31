# AGENTS.md — standing instructions for the agent working at this root

This is the workspace root of a cybermole install, and its terminals are
where the root agent works. **Scheduled or recurring work belongs in
cybermole jobs, not ad-hoc terminal sessions**: a job (name + 5-field cron
schedule, local time + one-line shell command, optionally tagged with an
app) survives reboots and restarts, keeps run history with exit codes,
and writes a durable per-run log. Fire one manually with
`cybermole-cli jobs run <name>`; `cybermole-cli jobs --help` documents every verb.

**Fired means started, not finished.** `run` answering ok means the run
session opened and the command is starting — the outcome lands in the
run history when the server's tick observes the finish (≤30 s after the
end). Poll `cybermole-cli jobs runs <name>` and **check the EXIT code before
declaring success**: '?' = not observed yet, keep waiting. A refused run
(`run_active`, exit 1) means the previous run is still live — wait, or
kill it. One run's log: `cybermole-cli jobs log <name> <firedAt>` (the newest
1 MiB); the firedAt (epoch ms) is the run's identity — copy it from
`runs`.

## The tool surface

The CLI (every verb takes `--json` for the server's raw answer):

    cybermole-cli jobs list [-a <app-slug>]              the definitions, next fires, live runs
    cybermole-cli jobs runs <name>                       run history (firedAt = run identity)
    cybermole-cli jobs log <name> <firedAt>              one run's log tail (newest 1 MiB)
    cybermole-cli jobs create --name <n> --schedule '<cron>' --command '<cmd>' [--app <app-id>]
    cybermole-cli jobs set <name> [--schedule '<cron>'] [--command '<cmd>'] [--app <app-id> | --clear-app]
    cybermole-cli jobs delete <name>                     drop the job, its history and logs
    cybermole-cli jobs run <name>                        fire now (409 while one is live)
    cybermole-cli jobs kill <name> <firedAt>             kill the job's live run
    cybermole-cli jobs validate [--schedule '<cron>'] [--command '<cmd>']

    cybermole-cli jobs create --name nightly --schedule '0 4 * * *' --command 'npm test'
    cybermole-cli jobs run nightly
    cybermole-cli jobs runs nightly
    cybermole-cli jobs log nightly 1736395200000

The same surface is in-session MCP tools — **cybermole-jobs**, registered
for every pi session by the agent-dir template's `mcp.json`:
`jobs_list`, `jobs_create`, `jobs_set`, `jobs_delete`, `jobs_runs`,
`jobs_log`, `jobs_run_now`, `jobs_kill`, `jobs_validate`, `apps_list`.
If that template is updated (a redeploy), run `/reload` inside pi to
pick it up.

## Apps — the builder loop

Apps are the webapps this console serves at `/apps/<slug>/`; the builder
page (`/builder`) is their portfolio. The whole app loop is tool-driven
through the **cybermole-apps** MCP, registered for every pi session by
the same template:

    scaffold        a new app tree at the apps root, from the starter template
    add_action      one action per call (route + MCP tool + store + component + tests)
    check           THE gate (astro check + tsc + unit tests + build) — re-run until green,
                    and never report an app done without a green one
    build           the build half alone
    register        the db row (the privileged act) — then reload
    reload          the app host's sync point (after register, unregister, a rebuild)
    status          the picture: registered, mounted, serving reason, build-stale, trees
    describe        one app's action vocabulary (its route table)
    call            one app action through the app host
    build_session   THE hand-off when the user asks for a new app (below)

An app tree's own `AGENTS.md` is its manual; its `README.md` documents
the shape. The worked example is the reference app, **notes** — a
finished tree grown through exactly these verbs. On the shipped compose
shape it is seeded at `apps/notes` here (unregistered by design);
`status` lists whatever unregistered trees the apps root holds on any
install. Read it (its README, its `src/routes.ts`) before building
something new, and register it to serve it.

### The hand-off: when the user asks for a new app

Don't build it in this terminal — the builder seat is a workspace on the
builder page:

1. `scaffold` the tree under the name the user used, `check` it green,
   `register` + `reload` — the row exists, the mount is live.
2. `build_session` with the brief: the user's ask verbatim plus what the
   builder needs (constraints, decisions already made, a pointer at the
   reference app). The tool opens the app's builder workspace, whose
   auto-opened agent takes the brief as its opening prompt and works,
   framed at the app (CYBERMOLE_WORKSPACE_FOCUS).
3. Send the user to the deep link the tool answers — or `/builder` — and
   end the turn. Any open console page toasts the session's opening.

From there this terminal is the orchestration seat: `status`, `register`
+ `reload` after the builder's rebuilds, jobs. The builder agent owns
the tree. (A session framed by CYBERMOLE_WORKSPACE_FOCUS **is** the
builder — it builds in the tree; it never calls `build_session`.)

App e2e (`npm run test:e2e` in a tree) runs in-place — the install image
ships the Playwright browsers.

**Building UI — Web Awesome first, strictly.** Every app UI uses the Web
Awesome component for the job whenever one exists (tabs
`wa-tab-group`/`wa-tab`/`wa-tab-panel`, `wa-button`, `wa-button-group`,
`wa-dropdown`, `wa-dialog`, `wa-callout`; layout `wa-stack`/`wa-cluster`
and the utility classes) — never a hand-rolled stand-in. Where none
fits, a one-line comment at the site says why. Markup lives in the
`.astro` (`<template>` skeletons for repeated items); enhancers clone and
fill it, never build HTML strings (CODE_STYLE.md §7 — `lint:arch` in
the tree's `check` enforces the mechanical half).

## Trust

Jobs are the root agent's to manage. App-level agents working in trees
below this directory also read this file by upward walk — accepted usage
(v1: one uid; a usage convention, not enforcement).

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
