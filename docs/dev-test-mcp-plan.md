# The dev test-MCP plan — quiet test runs for agents

Status: **shipped** — landed as `tools/dev-mcp/` (parsers, quiet runner,
stdio server), `tests/unit/dev-mcp.test.mjs` + fixtures, the
`.pi/mcp.json` registration (the one tracked exception under the ignored
`.pi/`), and the AGENTS.md Testing lead (§8). The branch's own demo, per
§9: the full ladder through the new tools — check 112 files clean, lint
0/136, build clean, units 367/367 in two lines of output, e2e 58/58 in
two lines (2m42s) — plus the kill-path drills (client timeout, client
close mid-run, external SIGTERM) that shaped the process-tree kills
below. Integration amendments, told where they changed the agreed plan:
the quiet reporter is a programmatic `run()` runner, NOT a
`--test-reporter` module — node's reporter IPC structured-clones the
event stream and strips Error messages/stacks entirely (assertion causes
survive only as enumerable fields), while `run()`'s in-process stream
carries the real Errors; that runner absorbs three verified Node 22
quirks (`run({ testNamePattern })` silently ignored — the pattern rides
execArgv to the per-file children; a stray `NODE_TEST_CONTEXT`, inherited
when the runner is spawned from inside a node:test child — exactly what
the dev-mcp unit suite does — makes `run()` "skip running files", so the
runner drops it and the server strips it from every child env; a file
that dies without running tests surfaces as an envelope `test:fail`
whose name is the file path, or a `subtestsFailed` envelope with zero
leaf failures — both become crash entries with the file's stderr tail,
and `counts.fail` is `max(summary.failed, leaves + crashes)` because the
summary counts an import crash but not a mid-run one) (§4 amended);
Playwright's list reporter still prints to stdout when the JSON report
goes to a file, so quiet ignores stdout and verbose passes it through,
and the report's error messages arrive ANSI-colored — the parsers strip
the escapes (§4 amended); the tools exec `node_modules/.bin/*` directly
(no npm/npx wrapper layer) and `&&` pipelines share one deadline while
composing per-step text (§3's "Runs" column, as-built); §1.7's timeout
kill grew into process-TREE kills — detached groups plus a /proc
ppid-walk for grandchildren that detach again (playwright's web
servers), and a SIGTERM handler with a reffed SIGKILL pass, because pi's
stdio-server shutdown SIGTERMs the server without running exit hooks
and a plain group kill never reaches a re-detached web server (learned
live: an abandoned run held the suite's ports); long runs carry
progress heartbeats (`notifications/progress` every 30s, only when the
client sent a progressToken) and the registration sets
`timeout: 3660`, because the MCP per-request default (60s) kills a
multi-minute run_e2e at the protocol layer regardless of the tool's own
timeout (§3 amended); the request's abort signal kills the in-flight
run's tree (§5's envelope unchanged). §6's flagged worktree-trust risk
is verified fact in §10's shipped notes. The body below is the
plan as agreed — the historical record, unchanged.

## 0. Problem and positioning

The repo ladder (AGENTS.md, Testing) is `check` → `lint`/`format:check` →
`build` → `test:unit` → `test:e2e`, run through bash. Every run dumps the
runner's human reporting into the transcript: Playwright prints a line per
test (51 e2e tests, most in a 2700-line spec) plus web-server boot noise and
multi-page stack traces; `astro build` prints its page table; ESLint prints
the stylish report. An agent iterating on a change runs the ladder many
times — success output is pure context waste, and it is ~100% of the output
on a passing run.

Two things the plan is **not**:

- **Not host-bridging.** Barbarus's MCP exists partly because its sandboxes
  have no `godot` — tests must run on the host and ship results back. Our
  fleet sandboxes are e2e-capable Node environments; the MCP runs wherever
  the session runs (host or sandbox), cwd = the checkout. stdio only, no
  sse/HTTP transport, no remote mode.
- **Not product surface.** `server/mcp.ts` (the jobs MCP) stays untouched:
  it is the shipped appliance's internal-API proxy — template-registered
  for every pi session, results verbatim, no logic. Test tools are the
  opposite kind of server (subprocess orchestration + output shaping) and
  live only in dev checkouts. Separate server, separate registration.

## 1. Barbarus's decisions, and what transfers

The transferable decisions, with their barbarus spellings:

1. **Structured envelope, never raw stdout.** Tools return
   `{passed, returncode, duration_s, quiet, output}`; integration-shaped
   tools add `failures: [{id, detail, …}]`. The agent reads `passed` first;
   `output` matters only on failure. (barbarus `run_unit_tests` /
   `run_integration`.)
2. **Quiet is the default; verbose is opt-in.** `quiet: bool = True` on
   every runner tool. Success is one glance (flag + counts); failure needs
   the detail — so the default inverts the information flow.
3. **Suppress at the source when the runner allows it; anchor-parse when it
   doesn't.** GUT gets `-glog=0 -gdisable_colors` (per-test names never
   printed); the integration runner gets `--quiet` (only failures +
   summary). Where no flag exists, `_quiet_gut_output` finds the
   `= Run Summary` banner and keeps from there — with a tail fallback when
   no banner exists (crash, "Nothing was run") so the cause stays visible.
4. **Failure context travels with the result.** `run_integration` parses
   the runner's PASS/FAIL lines into `failures[]` and tails each failed
   scenario's per-instance logs (80 lines) into the entry — the agent never
   re-runs or fishes for host files it cannot read.
5. **Bounded output.** `_trim_output`: 64 KB cap keeping head + tail (early
   parse errors and trailing summary are the parts that matter) with an
   explicit `…[N chars omitted]…` marker.
6. **Targeted-before-full parameters.** `script`/`test` for units,
   `mode`/`filter` for integration — the tool surface mirrors the
   verification ladder (targeted → whole suite → maybe full integration).
7. **Timeout per tool with kill** (`run_headless`: kill on timeout, raise
   with the command line).

What does **not** transfer: the AgentBridge/game-driving half (no analogue),
`get_logs` level/grep (job logs already have the jobs MCP; e2e web-server
stderr is captured by the e2e tool itself, §4), and managed/external process
modes (our tools are one-shot subprocesses only).

Where we can do **better** than barbarus: its runners print human text, so
quiet mode is regex-anchored post-processing. Our runners emit machine
formats natively — node:test structured events, Playwright `--reporter=json`,
ESLint `--format json` — so quiet mode is parsing, not pattern-matching, and
failures arrive structured for free. The anchor+tail fallback survives only
for `astro check` / `tsc` / `astro build`, whose output is already
error-only text.

## 2. Shape here

A repo-local stdio MCP server, plain `.mjs`, no build step (runs from any
checkout or sandbox worktree pre-build — matching the flat `tools/*.mjs`
precedent; nothing ships in the npm package, `files` already excludes
`tools/`):

```
tools/dev-mcp/
  server.mjs         entry: MCP SDK (already a dependency) over stdio;
                     registers the six tools; resolves the repo root from
                     import.meta.url (…/tools/dev-mcp → ../../) and runs
                     every child process with THAT as cwd, so the launcher's
                     cwd never matters
  quiet-reporter.mjs node:test reporter (§4)
  parsers.mjs        pure functions: playwright-json → failures, eslint-json
                     → summary, envelope/trim helpers — unit-tested
.pi/mcp.json         {"mcpServers": {"cybermole-dev": {"command": "node",
                     "args": ["tools/dev-mcp/server.mjs"], "exposure": "direct"}}}
```

Server name `cybermole-dev`; tools are direct-exposure (explicitly invoked).
Tool names: `run_check`, `run_lint`, `run_format_check`, `run_build`,
`run_unit_tests`, `run_e2e` — one per npm script, so the ladder in AGENTS.md
maps 1:1.

## 3. The tools

All share the envelope of §5, a `timeout` param (default per tool: 600 s
check/format, 300 s lint, 900 s build, 1800 s units, 3600 s e2e; kill on
expiry and report `timed_out`), and `quiet` (default true).

| Tool | Params beyond the shared ones | Runs | Quiet result |
|---|---|---|---|
| `run_check` | — | `astro check` + `tsc -p tsconfig.server.json --noEmit` | `{clean, errors[]}` — both commands are already error-only; text kept trimmed |
| `run_lint` | `fix?` | `eslint . --format json` (`--fix` when fix) | totals + per-file error messages; warnings as per-file counts |
| `run_format_check` | — | `prettier --check .` | offending files (already its whole output) |
| `run_build` | `server_only?` | `astro build && tsc -p tsconfig.server.json` (server_only = the tsc half) | errors; astro's page table dropped, boot tail kept |
| `run_unit_tests` | `file?`, `name?`, `skip_build?` | `tsc -p tsconfig.server.json` (as `test:unit` does; skip_build to reuse dist-server) then `node --test tests/unit/<…>` with the quiet reporter | counts + per-failure name/error/duration |
| `run_e2e` | `grep?`, `file?` | `npx playwright test --reporter=json` (JSON to a temp file, §4) | counts (passed/failed/flaky/skipped) + per-failure title, file:line, trimmed error; web-server stderr tail on infra failure |

`file` on `run_unit_tests` matches test-file stems (`ids` →
`tests/unit/ids.test.mjs`), the GUT `-gselect` analogue; `name` passes
through to `--test-name-pattern` (its `-gunit_test_name` analogue, and like
GUT it requires `file`). `grep` on `run_e2e` is Playwright's `--grep` over
titles; `file` takes spec paths — the targeted-before-full ladder.

The e2e tool does **not** manage the serial-host-run constraint (one
`/tmp/cybermole-itest` at a time) beyond running with the repo root as cwd
and the playwright config unchanged; the constraint stays an AGENTS.md rule,
enforced socially as today. Sandboxes are unaffected (per-container /tmp).

## 4. Quiet mechanics per runner

- **node:test — suppress at the source.** A custom reporter
  (`quiet-reporter.mjs`, ~40 lines) consumes the structured event stream and
  prints only diagnostics, `test:fail` entries (name, error, duration), and
  a final counts line — the exact analogue of GUT's `-glog=0` + summary
  anchor, except the summary is emitted by the reporter itself so no
  post-parse anchor can miss. On zero failures the whole output is ~5 lines.
- **Playwright — machine format + parse.** `--reporter=json` with
  `PLAYWRIGHT_JSON_OUTPUT_NAME` pointing at a temp file (JSON on stdout
  would be corrupted by the web-server's stderr, and the merged-stderr
  trick barbarus uses for the same reason doesn't work when stdout IS the
  machine channel — so stdout+stderr are captured separately; stderr rides
  the envelope tail). `parsers.mjs` walks the JSON: counts from `stats`,
  `failures[]` from results with `status: 'failed'|'timedOut'|'flaky'`,
  error text trimmed per-failure (~2 KB) rather than the report's full
  stack context. On infra collapse (web server never boots) there are no
  results — the tool answers `passed: false` + the stderr tail, the
  anchor-miss fallback in another shape.
- **ESLint — machine format + parse.** `--format json` → totals + errors in
  full + warnings per-file. (`--fix` keeps the same path: parse the report
  of the post-fix pass.)
- **astro check / tsc / astro build — anchor-parse text.** Output is
  already failure-only (errors listed, then a result line); quiet keeps
  errors + the trailing result line and drops everything else (build's page
  table, check's progress). If the process died without a result line, keep
  the tail — barbarus's no-banner fallback, same rationale.

## 5. The shared envelope

```jsonc
// every tool, always
{ "passed": true|false, "returncode": 0, "duration_s": 41.2, "quiet": true,
  "timed_out": false, "output": "…bounded text (§1.5: 64 KB head+tail trim)…" }
// plus, where parsed
{ "counts": { "pass": 51, "fail": 0, "skipped": 1 },
  "failures": [ { "name": "…", "file": "tests/e2e.spec.ts:120",
                  "error": "…trimmed…" } ] }
```

One vocabulary across all six tools, so an agent (and AGENTS.md) teaches one
shape. Errors as structured data first, bounded raw text as the fallback for
everything unparseable — barbarus's split, kept.

## 6. Risks / open integration details

- **Project trust in fleet worktrees.** pi reads `.pi/mcp.json` only from a
  trusted project; a fleet worker's cwd is a worktree path, not the trusted
  main checkout — the server may silently not register there. To verify at
  implementation: boot a sandbox worker, run `/mcp`. If untrusted, the fix
  is sandbox-pi-side (mark worktrees trusted) — flagged, not solved, here.
- **Reporter drift.** The Playwright JSON schema is not a contract. The
  parsers are defensive (missing fields → fall back to the raw-output tail)
  and unit-tested against a captured fixture blob, re-captured when
  Playwright bumps.
- **`npx playwright` from the MCP** must resolve the repo's playwright (cwd
  = repo root handles it; verify inside a sandbox once).

## 7. Testing the tooling itself

- `tests/unit/dev-mcp.test.mjs` against `parsers.mjs`: fixture eslint-json
  and playwright-json blobs (checked in under `tests/unit/fixtures/`),
  envelope/trim edge cases, anchor/tail fallbacks.
- One smoke test spawning `node --test` on a tiny fixture file with
  `quiet-reporter.mjs`, asserting the quiet shape (passing case; one
  deliberate failure case).
- The stdio server itself stays thin enough not to need its own harness
  (registration glue only — unlike `server/mcp.ts`, whose verbatim-proxy
  contract merited `mcp.test.mjs`).

## 8. Documentation changes

- **AGENTS.md (repo) Testing section**: lead with the MCP ladder — run
  validation through the `cybermole-dev` tools (quiet by default; verbose
  only when debugging the reporting itself), bash for interactive
  debugging only. Keep the npm scripts documented as the substrate.
- **This doc** flips to `Status: shipped` with integration amendments, per
  the jobs-agent-plan convention.

## 9. Build order

Small enough for one `task/dev-test-mcp` branch off main: `parsers.mjs` +
reporter + unit tests first (pure, reviewable), then `server.mjs` + the six
tools, then `.pi/mcp.json`, AGENTS.md, and a host + sandbox e2e-capable
self-check (the branch's own full suite run through the new tools is its
demo). Fleet merge process as usual — one branch at a time, orchestrator
runs e2e as the gate.

## 10. Shipped verification notes (§6, resolved to fact)

- **Worktree trust: the risk is real.** A fresh `git worktree` of the
  commit carries the tracked `.pi/mcp.json` (the gitignore exception
  works), and `pi mcp list` inside it does NOT register the server —
  untrusted project, exactly §6's flag. The fix stays sandbox-pi-side
  (mark worktrees trusted, or pre-seed trust for the worktree root);
  nothing to fix here. Until then, fleet workers get the tools only in
  trusted checkouts (the main checkout is trusted).
- **Self-location: verified in a worktree.** With `node_modules` present
  (a fresh worktree has none — gitignored; sandboxes `npm ci` first), the
  server launched from a worktree path with cwd elsewhere resolved the
  worktree's root from `import.meta.url`, compiled THAT tree's
  dist-server through `run_unit_tests`, and ran its tests (4/4 on ids).
- **The kill drills** (client timeout, client close mid-run, external
  SIGTERM to the server) each left orphaned e2e web servers holding the
  suite's ports before the process-tree kills landed — the /proc
  ppid-walk plus the reffed SIGKILL pass are what make `run_e2e` safe to
  abandon.
