## Live testing

- not seeing editor on server version
- code pattern from apps has not been applied to main application (eg it is still setting innerHTML in terminal-tabs.ts)
- wa-tab is not used for our tabs. Strict instructions must be given to all agents to ALWAYS use a wa-native solution when possible and conversion work must be done on the existing code
- 

## Human tasks

Write a refined agent workflow
HIG skill

Code style skill - typescript branded types etc
Component skills
Development / testing process
commits
How to scaffold an app eg write its AGENTS.md, always make an mcp with tools that match every user action


## Deferred, ignore

### Db
postgres option

### xterm
xterm:
  unicode-graphemes - emoji/combining chars currently render wrong-width in agent output (6.0-only on npm, experimental)
  
  font decision first, then: bundled mono webfont via web-fonts addon (needs xterm 6.1-beta) + ligatures if a ligature font

### MCP
cross-app MCP registration (siblings talk plain HTTP through the host)
  - only if the need turns up in use

  
### Worktrees
ability to make a workspace a worktree
ability to merge
  what happens on merge? does workspace archive or does it become a main-branch workspace?
implies app preview of some kind
have to be able to run worktrees

### Quality
playwright fuzzer/monkeys? fuzz based integration testing

### Packaging
Pull my typescript and astro and zod stuff out to packages
