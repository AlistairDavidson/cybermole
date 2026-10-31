## Live testing

- not seeing editor on server version
- console onto the apps' component pattern: TerminalTabs (wa-tab-group, template skeletons) and SingleView done; WorkspaceSidebar, AgentTerminal chrome and RunHistory done too; the rest is the LEGACY list in tools/arch-check-console.mjs (ratchet in `npm run lint`) — html.ts (parseServerHTML), flat files in src/components (console-events, editor-pane, jobs-events, signed-in-fetch → lib/ or component dirs), AppSettings/Settings/form dirs missing their <Name>.astro, Base.astro's reload button
- wa-native audit of the rest of the console (hand-rolled stand-ins for wa-* components) — rule now in AGENTS.md, CODE_STYLE §7, runtime/workspace-root/AGENTS.md, app-starter README
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
