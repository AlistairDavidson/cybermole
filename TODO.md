## Apps
Build out apps feature properly — plan agreed: docs/apps-plan.md (extensions,
same stack as the console, app host on the workspace side, root agents build /
app agents operate, first app notes-journal). Same epic line as before it was
planned: apps own their lifecycle via jobs + git, no cybermole deploy/rollback
machinery (docs/jobs-agent-plan.md §0)

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

## Infrastructure
preact signals - make this available for any frontend state needs apps might have in future
lit?

## Design
Mole icon

## Quality
playwright fuzzer/monkeys? fuzz based integration testing

## Console features

app preview?

self-naming workspaces

hideable nav on desktop

Rename "Console" -> "Cybermole"

## Workspaces follow-ups (deferred with the plan — docs/workspaces-plan.md §14)

terminal tab drag-reorder + workspace/app reorder UI (the sort_order columns exist)

workspace templates (pre-seeded terminals) — still deferred; per-app cwd (done — apps carry an optional cwd; new workspaces derive theirs from it)

app icons

editor extension/marketplace configuration beyond the VSCodium defaults (Open VSX, no telemetry)

pi-session resume as a workspace action ("resume a past agent session into a new terminal tab")

job exit-code notification hooks (deferred — jobs-agent-plan.md §11)

## Distribution
installation instructions / script for agents / actual scripts

## Packaging
Pull my typescript and astro and zod stuff out to packages


## Deferred, ignore
postgres option

 ```Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set -g
 extended-keys on` to ~/.tmux.conf and restart tmux.```

xterm:
  unicode-graphemes - emoji/combining chars currently render wrong-width in agent output (6.0-only on npm, experimental)
  
  font decision first, then: bundled mono webfont via web-fonts addon (needs xterm 6.1-beta) + ligatures if a ligature font
