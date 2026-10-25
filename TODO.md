## Apps
Apps own their lifecycle via jobs + git — no cybermole deploy/rollback machinery.

per-app e2e harness (kit cribs the console's hermetic pattern; the check verb's unit stage is the only app-side test story today)

app host fs-watch auto-reload (reload is verb-driven today)

cross-app MCP registration (siblings talk plain HTTP through the host)

WS routes for apps (crib the bridge code; the /apps proxy grows `ws: true`)

per-app agent access: per-app scoping/enforcement of jobs, per-app uids / separate sockets (v1 is one root agent, one uid)

server/mcp.ts still has its own socket client — move it onto src/lib/platform/internal-api-client.ts

main.ts static+middleware factoring (the app host carries its own small serve helper instead)

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

## Workspaces follow-ups

terminal tab drag-reorder + workspace/app reorder UI (the sort_order columns exist)

workspace templates (pre-seeded terminals)

per-workspace terminal command overrides

app icons

editor extension/marketplace configuration beyond the VSCodium defaults (Open VSX, no telemetry); curated per-app extension sets

editor host verification: open the Extensions viewlet and watch the iframe console for a CSP violation naming open-vsx.org — if it appears, add it to connect-src in editorSecurityHeaders() (src/lib/terminals/editor.ts); also check a CYBERMOLE_BASE=/foo deployment serves the workbench under /foo/editor/

pi-session resume as a workspace action ("resume a past agent session into a new terminal tab")

job exit-code notification hooks (webhook, Grafana alerting on the Loki labels)

job log size caps / rotation (no cap today)

retire the workspace sidebar's 15s poll in favour of the /ws/events bus (topic field already reserved)

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
