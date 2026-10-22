## Branding
New name -> cybermole

## Infrastructure
preact signals - make this available for any frontend state needs apps might have in future
lit?

## Quality
fleet agents need the ability to run e2e tests, dependencies set up for them so they don't churn
make flakey tests not flakey
playwright fuzzer/monkeys? fuzz based integration testing
automatically set dev credentials to `test`/`test`
don't lose dev state on restarts and make sure we don't lose server state

## Console features

popout behaviour improvement (_blank is better)
popout button off of tab
  -> combine with copy/download bar

app preview?

self-naming workspaces

ability to configure which agent is used - auto-opens as first terminal session (pi default)
ability to configure which terminal is used (zsh default)

hideable nav on desktop

global light/dark mode from browser, not hard coded
vscodium follow global light/dark mode

Rename "Console" -> "Global"

link to logs (page with grafana in an iframe)

## Workspaces follow-ups (deferred with the plan — docs/workspaces-plan.md §14)

terminal tab drag-reorder + workspace/app reorder UI (the sort_order columns exist)

workspace templates (pre-seeded terminals) — still deferred; per-app cwd (done — apps carry an optional cwd; new workspaces derive theirs from it)

app icons

editor extension/marketplace configuration beyond the VSCodium defaults (Open VSX, no telemetry)

pi-session resume as a workspace action ("resume a past agent session into a new terminal tab")

job exit-code notification hooks (deferred — jobs-agent-plan.md §11)

## Jobs

implement the jobs agent plan — DONE (docs/jobs-agent-plan.md, shipped: all seven §10 branches merged — the internal socket + API, the webpi CLI, the MCP server, the live jobs page, log caps, root-agent AGENTS.md seeding)

## Apps
Build out apps feature properly (its own future epic — apps own their lifecycle
via jobs + git, no web-pi deploy/rollback machinery; docs/jobs-agent-plan.md §0)

## Distribution
installation instructions / script for agents / actual scripts

## Packaging
Pull my typescript and astro and zod stuff out to packages

## Human UX tasks
Skills and other methods to enforce my coding patterns
Write a refined agent workflow
HIG skill

## Agentic shit
Code style skill - typescript branded types etc
Component skills
Development / testing process
commits
How to scaffold an app eg write its AGENTS.md, always make an mcp with tools that match every user action

## Deferred, ignore
postgres option

 ```Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set -g
 extended-keys on` to ~/.tmux.conf and restart tmux.```

xterm:
  unicode-graphemes - emoji/combining chars currently render wrong-width in agent output (6.0-only on npm, experimental)
  
  font decision first, then: bundled mono webfont via web-fonts addon (needs xterm 6.1-beta) + ligatures if a ligature font
