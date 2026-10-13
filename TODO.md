## Infrastructure
preact signals - make this available for any frontend state needs apps might have in future

## Quality
playwright fuzzer? fuzz based integration testing

## Console features
side-tab bar lets you open a given app
  pi
  zed
  terminal  
  app preview

self-naming sessions

generalise pi -> any agent

Better auth

## Apps
apps folder that contains git submodules
group sessions by app
ignore pi sessions not related to this project or one of its apps
console is an app
scheduler is an app
Top menu with all apps
new app
rename app
set app icon
delete app
console sidebar for when in other apps (in which case maybe console isn't an app)

app management mcp
how to build an app skills

## Distribution
installation instructions / script for agents / actual scripts

## Packaging
Pull my typescript and astro and zod stuff out to packages

## Human UX tasks
make sidebar much nicer - rebuild step by step
Skills and other methods to enforce my coding patterns
Write a refined agent workflow
HIG skill

## Deferred, ignore
when it stabilises, maybe build on pi-durable (is tmux still necessary with this?)

xterm:
  unicode-graphemes - emoji/combining chars currently render wrong-width in agent output (6.0-only on npm, experimental)
  
  font decision first, then: bundled mono webfont via web-fonts addon (needs xterm 6.1-beta) + ligatures if a ligature font
  skip: attach (our WS JSON protocol is richer: attach modes, resize, errors, status), canvas (deprecated, removed in xterm 6)
  
  search addon + ctrl+F bar (wa-input cluster in terminal toolbar, NOT the session sidebar - 15s innerHTML poll eats state) server backfill via `tmux capture-pane -S -5000 -p` written to WS on attach so resumed sessions have searchable scrollback

  serialize - "download transcript" / "copy output" button, zero server changes; maybe e2e assertions on terminal state
