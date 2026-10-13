# AGENTS.md

Notes for coding agents working in this repo. Overview + architecture: see
README.md.

## Code conventions

`docs/CODE_STYLE.md` covers the correctness rules: Result families with
closed error codes, branded IDs, shared node-free schemas, thin Astro API
routes behind the main.ts gate, HTML web components, and forms.
`docs/REFACTOR_STYLE.md` covers porting older code into them. Formatting
and comment density aren't prescribed; match the surrounding code.

## Testing

`npm run check` — `astro check` (the `.astro` files, `src/components`,
tests) plus a no-emit `tsc` of the server build. `astro build` does
not type-check, so run this before review.

`npm run test:unit` — node:test units in `tests/unit/` against the
compiled `dist-server` — `npm run build` first (tsc-only is enough:
`tsc -p tsconfig.server.json && npm run test:unit`).

`npm run test:e2e` — Playwright integration tests (chromium; browser must
exist in ~/.cache/ms-playwright). Fully hermetic: the config boots
`dist-server/server/main.js` against a `/tmp/web-pi-itest` workspace (own
state db, fixture pi sessions, dedicated `webpi-itest` tmux socket, a
deterministic `cmd.sh` session command). Tests must stay serial
(workers: 1): they share the per-IP login rate-limit budget and the tmux
socket, and the rate-limit test must run last. `login()` signs in through
the form once and reuses that cookie, which keeps the suite inside the
budget (10 / 15 min), so use it in new tests rather than signing in again.
For authenticated API calls use in-page `fetch` (`page.evaluate`), not
`page.request`: Playwright's API client doesn't send the `Secure` session
cookie over the suite's plain-http origin. Build first (`npm run build`)
or let global-setup do it when dist/ is missing.

## node:sqlite

The state db (`src/lib/db.ts`) uses the built-in `node:sqlite`, which
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
`~/projects/validation-enhancer` works), not just in the SSR HTML.

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

- New UI goes on Web Awesome components/utilities/tokens, not hand-rolled
  HTML/CSS (`.agents/skills/webawesome*` are the references). The app's
  identity lives in the `:root` semantic-token overrides in
  `src/styles/console.css` — extend those rather than adding hex/px literals.
- `console.css` is unlayered on purpose (must win over @layer'd Web Awesome
  styles) and is the only sanctioned place for hex colors.
- The session sidebar re-renders via `innerHTML` on a 15s poll — preserve
  transient state (e.g. input value/focus) in `render()`, and don't put
  stateful components (e.g. `wa-details`) in it.
- `agent-terminal` sizes itself with a `ResizeObserver` on `.terminal-container`; new
  layout around it must keep the box able to resize for any reason, not just
  window resizes.

## Fleet merge process

Fleet work lands on `task/*` branches (one per worker, all cut from the same
base). Integration is ONE BRANCH AT A TIME, reviewed as a staged whole —
never a blind merge commit:

1. Pick the next branch by dependency/conflict order, not launch order
   (plumbing before features that build on it; docs consolidation last).
2. `git merge --no-ff --no-commit <branch>` — the entire merged change sits
   STAGED on main with nothing committed (equivalent to merging, then
   undoing the commit so the whole change is staged). Resolve conflicts
   keeping BOTH branches' intent, and wire up junctions the workers designed
   to meet (they leave each other explicitly-marked hooks — read their
   comments).
3. Verify the merged tree before review: `npm ci` if the lockfile moved,
   `npm run build`, `npm run test:unit` (if the branch added one),
   `npm run test:e2e`.
4. Present the change as aspects with reviewer notes; the human edits and
   discusses the staged change until satisfied. Then it lands as ONE commit
   per branch on main (the granular history stays on the `task/*` ref),
   and the next branch starts at step 1.
