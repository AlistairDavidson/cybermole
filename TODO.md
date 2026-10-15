## Branding
New name

## Infrastructure
preact signals - make this available for any frontend state needs apps might have in future

## Quality
playwright fuzzer/monkeys? fuzz based integration testing
use linter
prettier
fully-working watch/dev mode (probably never astro dev tho
automatically set dev credentials
don't lose dev state on restarts and make sure we don't lose server state

## Console features

app preview?

self-naming workspaces

ability to configure default agent

in navigation, apps should be collapsible

maybe hideable nav on desktop

global light/dark mode from browser, not hard coded
vscodium follow global light/dark mode

configure terminal app and agent

no folder setting when creating workspace - "app" does that
I nav rename "Console" -> "App" or "Root" or "Global" or something

button to pop a tab to a window — DONE (task/pop-tab-window)

## Workspaces follow-ups (deferred with the plan — docs/workspaces-plan.md §14)

terminal tab drag-reorder + workspace/app reorder UI (the sort_order columns exist)

workspace templates (pre-seeded terminals); per-app cwd

app icons

editor extension/marketplace configuration beyond the VSCodium defaults (Open VSX, no telemetry)

pi-session resume as a workspace action ("resume a past agent session into a new terminal tab")

job log size caps / rotation; job exit-code notification hooks
  this should be with winston/loki/grafana

## Jobs

Agent console with AGENTS.md from this app that says how to manage jobs (can be opened)
Jobs MCP
Job page
  Agent console as above but told about this job (can be opened)

## App management

All apps get an app management page that allows you to manage rollbacks, see logs
console that knows to interrogate this page
Migrations

## Agentic shit
Code style skill - typescript branded types etc
Component skills
Development / testing process
commits
How to scaffold an app eg write its AGENTS.md, always make an mcp with tools that match every user action

## Distribution
installation instructions / script for agents / actual scripts

## Packaging
Pull my typescript and astro and zod stuff out to packages

## Human UX tasks
Skills and other methods to enforce my coding patterns
Write a refined agent workflow
HIG skill

## Deferred, ignore
postgres option

 ```Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set -g
 extended-keys on` to ~/.tmux.conf and restart tmux.```

xterm:
  unicode-graphemes - emoji/combining chars currently render wrong-width in agent output (6.0-only on npm, experimental)
  
  font decision first, then: bundled mono webfont via web-fonts addon (needs xterm 6.1-beta) + ligatures if a ligature font
  skip: attach (our WS JSON protocol is richer: attach modes, resize, errors, status), canvas (deprecated, removed in xterm 6)
  
  search addon + ctrl+F bar (wa-input cluster in terminal toolbar, NOT the workspace sidebar - 15s innerHTML poll eats state) server backfill via `tmux capture-pane -S -5000 -p` written to WS on attach so attached terminals have searchable scrollback

  serialize - "download transcript" / "copy output" button, zero server changes; maybe e2e assertions on terminal state
