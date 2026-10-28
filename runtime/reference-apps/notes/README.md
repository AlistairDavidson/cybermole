# Notes — the reference app

This tree is cybermole's **reference app**: the
notes/journal webapp built THROUGH the apps verbs — `scaffold`, five
`add_action` calls, `check`, `register`, `reload` — as the epic's
acceptance run, kept in the image as living documentation of what a
finished app tree looks like. It is a normal app tree like any other:
an Astro SSR app on `@cybermole/app-kit` (the route table, the typed
client, the sqlite helper), served by the app host at `/apps/notes/`
behind the console's login once it is registered and built.

- `src/routes.ts` — THE route table: `ping` (the starter's example,
  kept) plus the notes vocabulary — `note_create`, `note_list`,
  `note_get`, `note_edit`, `note_archive`. Every face (the pages, the
  app's MCP tools, the root agent's `describe`/`call`) binds from this
  one table; `dist/route-table.json` is emitted by the build.
- `src/lib/` — the domain: `notes-core.ts` (pure shapes, validation,
  search patterns), `note_*.ts` (one Result family per action, taking
  the store as a parameter so the unit tests run against an in-memory
  fake), `notes-db.ts` (the sqlite half — `data/app.db`, gitignored).
- `src/pages/` — the list page (SSR over `note_list`, a no-JS search
  form, the capture editor) and the note page (SSR over `note_get`, the
  editor for `note_edit`/`note_archive`). Both embed the agent drawer
  (`<agent-console slug="notes">` — the app-starter README §
  The agent drawer has the contract): one terminal in this tree's
  operator workspace, plus the builder deep link.
- `src/components/` + `src/store/` — the interactive half (CODE_STYLE.md
  §7): Astro SSR components enhanced by HTML web components
  (`<notes-ping>`, `<notes-editor>`, `<notes-list>` — the enhancers wire
  the SSR'd children from `connectedCallback`) over signals stores
  (`@preact/signals-core`) that act through the typed route client. The
  tree's `lint:arch` check (part of `npm run check`) enforces the
  component standard's mechanical rules.
- `AGENTS.md` — the operator's manual for agents working in this tree.

## The live list (the WS example)

The list page is live: every open tab updates on any write, with no
reload and no polling. It is the worked example of an app WebSocket
route (the app-starter README § WebSocket routes has the contract):

- `src/ws.mjs` — the WS entry the build copies to `dist/server/ws.mjs`.
  It watches `data/` and broadcasts `{"type":"notes_changed"}` on any
  `app.db*` touch (debounced). One-way, self-contained — no `src/lib`
  imports, `node:` builtins and `ws` only.
- `<notes-list>` (the page's live-list component) owns the doorbell: its
  enhancer dials `/apps/notes/ws` through the kit's `createAppSocket`
  (zod-validated frames, capped-backoff reconnect — the host cuts
  tunnels on logout/expiry without a close handshake) and answers
  `notes_changed` by refreshing through the typed `note_list` client —
  the same action every face serves — then rebuilding the list's items
  surgically from the store's signal. The find form and the editor keep
  their state; the SSR list stands until the first refresh.

The split is the point: **WS carries the nudge, HTTP actions carry the
 data.** The same signal makes the capturing tab's own list refresh
 after a save (a save used to leave the SSR list stale until a manual
 reload).

## The seeding contract

This tree ships in the image and seeds into the install's apps root
only-where-absent (the `runtime/workspace-root/` precedent: an existing tree at
the apps root always wins, and nothing here ever overwrites `data/` —
the user's notes). **Nothing auto-registers — registration is the
privileged act** (§8): the seeded tree stands unregistered, `status`
shows it among the unregistered trees, and one `register` + `reload`
from a root agent (the `cybermole-apps` MCP) makes it live. The
starter template new apps scaffold from stays blank.

## The loop (root agent)

```text
scaffold  (already done — this tree IS the scaffold, grown)
check     the tree's own gate: lint:arch + astro check + tsc + unit tests + build
test:e2e  the browser half (below) — outside the gate on purpose
register  the db row (the privileged act)
reload    the app host's sync point — the mount appears
```

In the tree itself: `npm run setup` (link the core stack — the
per-package node_modules symlinks into the install), `npm run check`
(the gate), `npm run build` (dist/ + route-table.json + the
self-containment gate).

## End-to-end tests (`npm run test:e2e`)

The app-side e2e twin of the console's `apps-notes` spec: the kit's
harness (`@cybermole/app-kit/testing`) boots this tree's built
`dist/server/entry.mjs` on an ephemeral loopback server — ephemeral port,
throwaway data dir (`appDataDir()` honors `CYBERMOLE_APP_DATA_DIR`, so the
tree's real `data/` is never touched) — and Playwright walks the use loop
against the pages directly (`tests/e2e/notes.spec.ts`: capture → find →
open → edit → archive, plus the empty-title error face). No console origin,
login or session gate, and no WS tunnel — those faces stay with the
console's own suite; a reload stands in for the live list's nudge. Needs
Playwright's chromium (the run says so, clearly, when it's missing).
