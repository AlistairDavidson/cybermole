# Pi Durable — research report & implications for cybermole

*Research date: 2026-10-03. Package investigated: `@earendil-works/pi-durable@1.0.1` (published alongside Pi 1.0, ~1 day old at time of writing).*

Sources examined:

- Announcement: <https://earendil.com/posts/pi-durable/> (with the [Pi 1.0 post](https://earendil.com/posts/pi-1-0/))
- Package README + TypeScript API (npm tarball unpacked to `/tmp/pi-durable-pkg/package/`)
- Repo: <https://github.com/earendil-works/pi> — `packages/durable` (~15k lines of TS), 30+ runnable examples in `test/examples/`, design docs (`docs/spec.md`, `docs/pico-v5-handoff.md`), and two demo apps (`packages/coding-agent/src/experimental/durable` and `.../vacation`)
- Local pi install (1.0.0) docs — checked for any durable surface in the CLI/RPC (there is none; the word "durable" appears in pi's docs only incidentally)

## What pi-durable is

Not a new mode of the pi coding agent — the announcement is explicit: *"It does not replace the Pi coding agent. It is a framework for building any agentic application, coding agents included."* A harness here means **storage plus the machinery to run one or more LLM conversations in parallel**, where **everything the harness runs — model requests, tool calls, compaction, your own state machines — is a durable task with checkpoints**.

Core mechanics:

- **Storage backends**: memory, SQLite (`openNodeSqliteStorage`), JSONL; portable cores that run without Node APIs (Bun, Cloudflare Durable Objects); a conformance suite (`@earendil-works/pi-durable/testing`) for custom backends. **One process owns a storage at a time; other clients attach to that process.** No cross-process locking.
- **Crash recovery**: process dies → new process opens the same storage → `resume()` continues unfinished tasks from their last checkpoint. A cut-off model request is re-sent (partial answer stays in the transcript, marked aborted); a tool reruns only if declared `replay: "safe"`, otherwise the model is told it was interrupted. Queued messages stay queued. Submissions with the same `requestId` are exactly-once.
- **Conversations**: root conversation + arbitrary others + **forks** (a fork sees the parent's entries up to a chosen point, without copying). Each conversation stores its own agent: model, thinking level, selected extensions/tools, instructions, cwd.
- **Multiplayer / UI attachment**: "everything a UI needs is committed state, so any number of clients can attach to any conversation." `viewState()` gives the current view (transcript, streaming answer, running tools, inbox, agent, usage) as a subscribable read-only state; `watch()` streams the exact commit operations ("small enough to send over a socket"); `watchEvents()` converts commits into coding-agent-style events (`message_start`, `tool_execution_start`, …). A client that joins late or reconnects starts from the current view — nothing is replayed. Any client can **steer a busy conversation** (`whenBusy: "steer"`), queue follow-ups, or withdraw queued input.
- **Documents**: typed JSON application state (`defineDoc`) committed atomically with the transcript — todos, plans, tickets; UIs can subscribe per document. What a fork starts with is per-document configurable (`initial` / `current` / `asOf`).
- **Extensions**: named bundles of system-prompt sections, tools, hooks, wrappers, and tasks, installed in a registry that can **hot-reload while conversations run** (running calls finish on old code; next call uses new code). Hooks cover `beforeTool`/`afterTool` (block/rewrite), `beforeRequest`, `onYield`, `afterTools`, `beforeCompact`.
- **Subagents** aren't built in but are "a few lines of code": a tool creates an owned conversation and waits for its answer; ownership makes abort/cleanup automatic and crash-rerun finds the same child.
- **Compaction** is itself a background task; the conversation keeps working while older messages are summarized; manual `compact(instructions)` and `reset(handoffNote)`; older messages always stay in storage and remain searchable.
- **Usage/cost**: per-conversation token/cost totals in a `pi.usage` document, plus session-wide totals.

Notable gaps vs the pi coding agent (as of 1.0.1): built-in coding tools are only read/write/edit/bash; **no image reading, no skills, no MCP, no pi-extension ecosystem**. The "small coding agent on Pi Durable" in the repo is a demo, not the product. Pi 1.0's CLI itself exposes no durable mode, flag, or RPC (verified against the installed 1.0.0 docs).

Maturity: explicitly **experimental** — the README's first line is *"The API changes without notice between releases."* Deps: `@earendil-works/chord`, `@earendil-works/pi-ai`, `diff`, `typebox` (notably *not* pi-agent-core — the tooling is its own implementation).

## What tmux does for cybermole today

Four distinct jobs:

1. **Process host** — keeps pi alive when the browser tab (or our Node server) goes away; on a bare host the tmux server is a separate daemon, so a cybermole crash doesn't touch sessions. In the container it doesn't hold: the Node server is init's only child, so when it exits the container stops and tmux goes with it.
2. **Attach/detach multiplexer** — live attach via `attach -d`; planned `capture-pane` scrollback backfill on attach.
3. **Terminal backend** — the medium for pi's TUI itself: scrollback, resize, the thing xterm.js talks to through node-pty.
4. **Generic process runner** — `CYBERMOLE_COMMAND` can be any CLI; the TODO's Zed-webapp / raw-terminal / app-preview tabs need this too.

## Would pi-durable remove the need for tmux?

**For agent sessions: yes, in principle — and it's a strictly better durability model.** Jobs 1–3 above are replaced by: WS → `watch()`/`submit()` structured ops (transcript, streaming answer, tool calls, inbox, usage — no screen-scraping a TUI), "kept alive" upgraded to "checkpointed" (survives server crashes, OOM, redeploys, machine sleep; nothing in flight is lost), and `attach -d` session-stealing upgraded to true N-client multiplayer with steering.

**But not now, and not entirely:**

- **It's a framework, not a product.** Adopting it means *building* the web console as a structured transcript renderer (tool cards, approvals as UI events, inbox) — a rewrite of `agent-terminal`/`ConsoleApp`, not a transport swap. Arguably a better end-state UI for a web console, but a big lift.
- **Feature-parity gap** (see above): sessions run through pi-durable today lose skills, MCP, images — much of what makes pi good.
- **tmux survives jobs 3–4**: arbitrary TUIs (Zed tab, raw terminal, previews) can't be conversations. The end-state architecture is **hybrid**: durable harness for agent conversations; pty/tmux for terminals.
- **Operational shape changes subtly**: today pi runs in separate tmux-hosted processes — a pi OOM can't take down the Node server, and a server crash doesn't pause agents. The durable harness must be the single storage owner: either in-process with the web server (then a server crash *pauses* all agents until restart, though nothing is lost), or a dedicated sidecar process that clients attach to (supported by the attach model, and the better fit for our systemd layout — give it its own unit).

## Mapping to our TODO

| TODO item | Pi Durable answer |
|---|---|
| "DB backend (pi-durable supplies this?)" | Yes — SQLite/JSONL backends + conformance suite for custom ones |
| "when it stabilises… (is tmux still necessary?)" | For agent sessions, yes; for terminal-app tabs, no — keep tmux |
| Session sidebar (JSONL scraping in `src/lib/sessions.ts`) | First-class `scanConversations` + documents; kills mtime/200-file/preview-byte heuristics |
| Self-naming sessions | A conversation document (the README's `app.todos` example is exactly this pattern) |
| Group sessions by app | Conversation metadata / per-app storage |
| Session search | `scanEntries` — searches pre-compaction and pre-handoff history too |
| Delete session / session mgmt tools | Conversation lifecycle natively, vs filesystem surgery on JSONL today |
| Scrollback backfill on attach (`capture-pane -S -5000`) | Obsolete — reconnect gets current view + deltas |
| "Cron" management (systemd) | Durable tasks have timers that survive restarts; complements (not replaces) systemd for arbitrary jobs |
| Better auth → multi-user | Multiplayer steering by multiple humans is a stated design goal |

Free capabilities we don't have today: **fork any past session** at any point (branch-and-compare beats append-only `--session` resume), steer-while-busy, background compaction for long runs, per-conversation usage/cost panels, idempotent submissions.

## Recommendation

The TODO's instinct ("when it stabilises") is right — **don't migrate now**. Low-regret moves today:

1. **Make pi a real dependency** pinned to 1.0 (already a TODO; pi-durable requires `pi-ai ^1.0.1` anyway).
2. **Abstract the sidebar's data source** behind a "list/query conversations" interface so a durable storage can later feed the same UI.
3. **Prototype out-of-tree**: a SQLite harness sidecar exposing one conversation via `watchEvents()` over WS, rendered as a transcript pane behind a flag — as an extra "app" in the planned apps folder. Validates the UI shape and the API before committing.

And watch for the cheapest path of all: **pi-the-CLI gaining a durable mode or RPC bridge** — that would give cybermole durability while keeping tmux and the TUI, with no UI rewrite. The announcement says lessons from pi-durable "flow back into Pi the coding agent as they prove themselves valuable," so convergence is likely.
