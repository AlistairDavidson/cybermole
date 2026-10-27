## Apps
Apps have a single slide-in agent console, same UI across all apps, cwd to the app
  - drawer from right, fills screen on mobile
  
Apps have link to their build console (builder page, first workspace of this app selected)

Apps own their lifecycle via jobs + git — no cybermole deploy/rollback machinery.

per-app e2e harness (kit cribs the console's hermetic pattern; the check verb's unit stage is the only app-side test story today)

app host fs-watch auto-reload (reload is verb-driven today)

cross-app MCP registration (siblings talk plain HTTP through the host)

WS routes for apps (crib the bridge code; the /apps proxy grows `ws: true`)

per-app agent access: settled 2026-10 — one uid for everything, no per-app sandboxing; the slide-in console controls scope by framing (app cwd + AGENTS.md + app MCP)

main.ts static+middleware factoring (the app host carries its own small serve helper instead)

add a slight fade-in when switching to console pages

## Console features

Popout should only pop out that one tab's contents - we need a layout without all the title bar and nav and such
toolbar for editor, popout button only


## Workspaces follow-ups

app icons

editor extension/marketplace configuration beyond the VSCodium defaults (Open VSX, no telemetry); curated per-app extension sets

editor host verification: open the Extensions viewlet and watch the iframe console for a CSP violation naming open-vsx.org — if it appears, add it to connect-src in editorSecurityHeaders() (src/lib/terminals/editor.ts); also check a CYBERMOLE_BASE=/foo deployment serves the workbench under /foo/editor/

job exit-code notification hooks (webhook, Grafana alerting on the Loki labels)


## Git
ability to make a workspace a worktree
ability to merge


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

## Quality
playwright fuzzer/monkeys? fuzz based integration testing

## Distribution

(done 2026-10: install guide + scripts, zsh init seeding — docs/guides/installation.md, deploy/*.sh)

## Packaging
Pull my typescript and astro and zod stuff out to packages


## Deferred, ignore
postgres option

 ```Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set -g
 extended-keys on` to ~/.tmux.conf and restart tmux.```

xterm:
  unicode-graphemes - emoji/combining chars currently render wrong-width in agent output (6.0-only on npm, experimental)
  
  font decision first, then: bundled mono webfont via web-fonts addon (needs xterm 6.1-beta) + ligatures if a ligature font
