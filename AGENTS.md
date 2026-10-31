# AGENTS.md

Notes for coding agents working in this repo. Overview + architecture: see
README.md.

## Code conventions

`docs/conventions/CODE_STYLE.md` covers the correctness rules: Result families with
closed error codes, branded IDs, shared node-free schemas, thin Astro API
routes behind the main.ts gate, HTML web components, and forms.

Comments are short and only say what the code can't: why, invariants,
non-obvious constraints.

## Testing

Validation runs through the `cybermole-dev` MCP tools (registered by
`.pi/mcp.json`, implemented in `tools/dev-mcp/`):
`run_check`, `run_lint`, `run_format_check`, `run_build`, `run_unit_tests`,
`run_e2e` — one per npm script below. Every tool answers ONE quiet envelope
(`{passed, returncode, duration_s, quiet, timed_out, output, counts?,
failures?}`): read `passed` first, counts on a glance, failure detail in
`failures[]` — success costs ~2 lines of context instead of per-test
reporting (a full e2e run is two lines). `run_unit_tests` narrows by `file`
(stem) and `name` (pattern, needs file), `run_e2e` by `grep`/`file` — targeted
before full. `quiet: false` is for debugging the reporting itself. Bash the
npm scripts only for interactive debugging (a REPL loop, watching a run
live); they stay the substrate and the tools' contract.

`npm run check` — `astro check` (the `.astro` files, `src/components`,
tests) plus a no-emit `tsc` of the server build. `astro build` does
not type-check, so run this before review.

`npm run lint` / `npm run lint:fix` — ESLint 9 flat config
(`eslint.config.mjs`): typescript-eslint strict + type-checked promise
rules over `src/`, `server/`, `tests/`, `tools/` and the `.mjs` configs.
Per-line disables in the code mark deliberate idioms (escaped `\-` in
schema regexes, the distribution `any` in the kit's `types/result.ts`,
computed `delete`s) — don't "fix" those.

`npm run format` / `npm run format:check` — Prettier (`.prettierrc`,
code-only scope per `.prettierignore`). The repo-wide `npm run format` has
been applied — `format:check` is green across the tree; keep it that way in
your changes (format files you touch before review).

`npm run test:unit` — node:test units in `tests/unit/` against the
compiled `dist-server` — `npm run build` first (tsc-only is enough:
`tsc -p tsconfig.server.json && npm run test:unit`).

`npm run test:e2e` — Playwright integration tests (chromium; browser must
exist in ~/.cache/ms-playwright). Fully hermetic: the config boots
`dist-server/server/main.js` against a `/tmp/cybermole-itest` workspace (own
state db, fixture workspace tree (apps/workspaces/terminal rows, live tabs
on a dedicated `cybermole-itest` tmux socket), a deterministic `cmd.sh`
terminal command). Tests must stay serial
(workers: 1): they share the per-IP login rate-limit budget and the tmux
socket, and the rate-limit test must run last. `login()` signs in through
the form once and reuses that cookie, which keeps the suite inside the
budget (10 / 15 min), so use it in new tests rather than signing in again.
For authenticated API calls use in-page `fetch` (`page.evaluate`), not
`page.request`: Playwright's API client doesn't send the `Secure` session
cookie over the suite's plain-http origin. Build first (`npm run build`)
or let global-setup do it when dist/ is missing.

Test residue self-heals: teardowns never run when a run is killed or
crashes, and several specs boot private servers whose tmux panes (an
auto-opened agent tab's pi/npm install) keep writing into their state
dirs after the server dies. `tools/test-cleanup.mjs` is the janitor —
every `cybermole-*` tmux socket except the shared `cybermole-itest` is
kill-servered (plus fixture-looking sessions on the default `cybermole`
socket, the operator's own), and every swept `cybermole-*` /tmp directory
is removed, protected: `cybermole-itest*` (the live hermetic world) and
`cybermole-dev-e2e-*` (the dev MCP's report dir). The e2e global-setup
runs it before spawning fixtures, so a crashed run cleans up on the next
one; `npm run test:cleanup` (or `--dry-run`) does it standalone.

The `tests/e2e/apps-*.spec.ts` files add the apps-e2e discipline: the whole suite's login budget is
shared through the cookie file in `tests/support/env.ts` (readSharedSessionCookie
— the first apps spec to need a browser signs in, the rest reuse the
cookie; never a fresh form sign-in per file), each spec sweeps its OWN
slug's world at entry (marker-gated once per run inside the hermetic
APPS_ROOT, which global-setup's per-run rm -rf makes run-scoped), there
is deliberately NO afterAll teardown (the run's cleanup is structural —
rows die with the per-run db, trees with the per-run workspace rm), and
per-test preconditions are re-established idempotently
(`ensureRegisteredAndMounted`), because the scheduler may split a file
across replacement workers. New app-touching specs follow the same
shape — and `tests/e2e/apps-notes.spec.ts` is the worked example: it seeds
the shipped `runtime/reference-apps/notes` tree into the hermetic apps root,
gates it green through the check verb, and walks the use loop through
the console origin on every face.

The e2e suite also runs inside fleet sandboxes: the repo's
`.sandbox-pi.json` selects the `agent-sandbox-node` image (tmux,
node-pty's build toolchain, chromium's runtime libs + fonts — see
`~/sandbox-images/`) and mounts the host browser cache read-only plus
shared npm/node-gyp caches, so `npm ci` → build → units → e2e needs no
setup and no workarounds (a full cold ladder is a few minutes). Each
container has its own `/tmp`, so worker runs never collide with each
other or with a host run. If Playwright complains about a missing
browser revision, the host cache is stale: run `npx playwright install
chromium` on the HOST once — the sandbox mount is read-only. Assertions
that poke the environment directly must stay gVisor-tolerant (tmux's
`#{pane_current_path}` resolves empty there — pty-master TIOCGSID is
ENOTTY — and fast-boot timing can outpace a live status poll; prefer
round-trips through the UI and pre-installed recorders over side-channel
probes).

## node:sqlite

The state db (`src/lib/platform/db.ts`) uses the built-in `node:sqlite`, which
still prints a one-line `ExperimentalWarning: SQLite is an experimental
feature…` the first time it loads in a process. **This warning is
expected** — it appears in the server's boot log, `set-password` output
and e2e webServer/test stderr, and means nothing is wrong. Don't add
suppression for it.

## Web Awesome (wa-*) components: SSR imports ≠ client imports

Astro frontmatter imports are **server-only**. Importing
`@awesome.me/webawesome/dist/components/<name>/<name>.js` in frontmatter SSRs
the component (astro-lit, declarative shadow DOM) but does **not** ship its JS
to the browser. The page will *look* fine, but the element never upgrades:
form controls lose form association (submit/Enter do nothing), `.value` is
missing, toggles are dead. This broke the login page once — caught only by
end-to-end testing.

Never write a literal script open-tag in an `.astro` **JS comment** (e.g.
"the `<script>` below re-imports them"): vite's rolldown dep-scan treats
`.astro` as HTML-like, strips only HTML comments, then parses every script
block it finds as JS — the tag in a frontmatter comment once made it parse
half the file as one broken module and killed `astro dev` with a cryptic
`PARSE_ERROR` at `virtual-module:…?id=0:1:7`.

**Rule:** every SSR'd `wa-*` component must *also* be imported in a
client-side `<script>` (see `src/pages/login.astro` for both halves, and
`src/components/ConsoleApp/ConsoleApp.astro` + `console-app.ts` for the
same split inside an Astro component wrapper). The client script must
import `@awesome.me/astro-lit/dsd-polyfill.js` and
`hydration-support.js` **before** any wa-* module — if the SSR'd element
defines first, Lit renders a second copy next to the declarative-shadow-
DOM content (everything appears twice; layout doubles in height). After
adding a `wa-*` element to a page, verify it
upgrades in a real browser (headless Chromium via the playwright install in
`~/projects/validation-enhancer` works, as does a fleet sandbox — see
Testing), not just in the SSR HTML.

### Forms on wa-* controls

- Validation: wrap the `<form>` in `<validation-enhancer-zod>` (import
  `validation-enhancer/zod` client-side) and hand it the schema the
  server parses with: `setZodSchema(Schema)` once
  `customElements.whenDefined('validation-enhancer-zod')` resolves.
  Spread `zodSchemaToHTMLAttributes(Schema)` (src/lib/web/zod.service.ts)
  onto the fields in the frontmatter.
- Errors go in the field's **hint slot**: use
  `src/components/form/WaField.astro` (`as="textarea"` for a textarea). The
  real `<input>` is in the wa-input's shadow DOM, so `aria-errormessage` /
  `aria-invalid` on the host never reach it; its `aria-describedby` points
  at the hint slot, so a message there is announced (e2e asserts this
  with `toHaveAccessibleDescription`).
- Listen for `submit` on an element **above** the enhancer. It stops an
  invalid submit from propagating; a listener on the form itself fires
  (target phase) before validation runs. A button outside the form (e.g.
  a `wa-dialog` footer) calls `form.requestSubmit()`.
- An empty `wa-input`'s `.value` is `null`, not `''`.
- Boolean attributes on `wa-*` in Astro markup: astro-lit renders
  `checked={false}` as `checked="false"` and `disabled={undefined}` as
  `disabled="undefined"`. Both are *present* attributes, which means true.
  Spread the attribute in only when it's on (see `flag()` in
  `SettingsView.astro`).
- Server-rendered fragments (`/partials/*`) go into the page with
  `parseServerHTML` (`src/components/html.ts`, which uses `setHTMLUnsafe`)
  so SSR'd `wa-*` keep their declarative shadow DOM and hydrate. Handle
  their events by delegation on the enhancing element.
- **No JS, no wa-* forms:** without upgrading, a `wa-input` still renders
  (declarative shadow DOM) and accepts typing, but its input is inside the
  shadow root and has no `name`, so a native submit carries none of its
  value (verified in Chromium with JS disabled). A form that must work
  without JS uses native `<input>`/`<button>`, which `webawesome.css`
  already styles (it includes `native.css`).

## UI conventions

- **ALWAYS use the Web Awesome-native solution when one exists** — this
  is strict, not a preference. Before writing UI, look the need up in
  `.agents/skills/webawesome/references/choosing-components.md` and use
  the component: tabs are `wa-tab-group`/`wa-tab`/`wa-tab-panel` (see
  `src/components/TerminalTabs/`), buttons `wa-button`, split buttons
  `wa-button-group`, menus `wa-dropdown`, dialogs `wa-dialog`, layout
  `wa-stack`/`wa-cluster` and the utility classes. Hand-rolled HTML/CSS
  standing in for a wa-* component is a defect. Where none fits, leave a
  one-line comment at the site saying why. Code you touch that
  hand-rolls something wa-* covers gets converted in the same change.
- The console follows the same component architecture as the apps
  (`docs/conventions/CODE_STYLE.md` §7) — Astro components SSR'd, enhanced
  by HTML web component enhancers, live state in `@preact/signals-core`
  stores; say "component", never "island". No HTML strings on the client:
  no `innerHTML`/`insertAdjacentHTML` writes, no markup in template
  literals, no `document.createElement` for structure — the `.astro` holds
  the markup (`<template>` skeletons for anything stamped per item) and
  the enhancer clones and fills it. `TerminalTabs/` is the console's
  worked example, the notes app's `NotesList/` the apps'. `npm run lint`
  ends with the architecture lint as a ratchet
  (`tools/arch-check-console.mjs`): a new violation fails, and its
  `LEGACY` list (the files still on the old patterns —
  `workspace-sidebar`'s `innerHTML` re-render among them) only shrinks.
  When you convert one, lower or delete its entry.
- The app's identity lives in the `:root` semantic-token overrides in
  `src/styles/console.css` — extend those rather than adding hex/px literals.
- `console.css` is unlayered on purpose (must win over @layer'd Web Awesome
  styles) and is the only sanctioned place for hex colors.
- The workspace sidebar (`src/components/workspace-sidebar.ts`) re-renders via
  `innerHTML` on every state refresh (push events over `/ws/events`, plus a
  re-sync on socket (re)connect) — preserve
  transient state (e.g. input value/focus) in `render()`, and don't put
  stateful components (e.g. `wa-details`) in it.
- `agent-terminal` sizes itself with a `ResizeObserver` on `.terminal-container`; new
  layout around it must keep the box able to resize for any reason, not just
  window resizes.
