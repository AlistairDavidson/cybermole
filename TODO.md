## Apps
per-app e2e harness (kit cribs the console's hermetic pattern; the check verb's unit stage is the only app-side test story today)

cross-app MCP registration (siblings talk plain HTTP through the host)


main.ts static+middleware factoring (the app host carries its own small serve helper instead)

## Workspaces follow-ups


job exit-code notification hooks (webhook, Grafana alerting on the Loki labels)

## Worktrees
ability to make a workspace a worktree
ability to merge
  what happens on merge? does workspace archive or does it become a main-branch workspace?
implies app preview of some kind
have to be able to run worktrees

## Human UX tasks
Review the notes app, finalise technical and stylistic decisions 
Discuss with AI how to turn that into skills and linting
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
lit? preact?

## Quality
playwright fuzzer/monkeys? fuzz based integration testing

## Packaging
Pull my typescript and astro and zod stuff out to packages


## Deferred, ignore
postgres option

 ```Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set -g
 extended-keys on` to ~/.tmux.conf and restart tmux.```

xterm:
  unicode-graphemes - emoji/combining chars currently render wrong-width in agent output (6.0-only on npm, experimental)
  
  font decision first, then: bundled mono webfont via web-fonts addon (needs xterm 6.1-beta) + ligatures if a ligature font
