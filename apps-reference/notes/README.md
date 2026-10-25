# Notes — the reference app

This tree is cybermole's **reference app** (docs/plans/apps-plan.md §9): the
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
  form, the capture island) and the note page (SSR over `note_get`, the
  editor island for `note_edit`/`note_archive`).
- `AGENTS.md` — the operator's manual for agents working in this tree.

## The seeding contract (docs/plans/apps-plan.md §9)

This tree ships in the image and seeds into the install's apps root
only-where-absent (the `root-agents/` precedent: an existing tree at
the apps root always wins, and nothing here ever overwrites `data/` —
the user's notes). **Nothing auto-registers — registration is the
privileged act** (§8): the seeded tree stands unregistered, `status`
shows it among the unregistered trees, and one `register` + `reload`
from a root agent (the `cybermole-apps` MCP) makes it live. The
starter template new apps scaffold from stays blank.

## The loop (root agent)

```text
scaffold  (already done — this tree IS the scaffold, grown)
check     the tree's own gate: astro check + tsc + unit tests + build
register  the db row (the privileged act)
reload    the app host's sync point — the mount appears
```

In the tree itself: `npm run setup` (link the core stack — the
per-package node_modules symlinks into the install), `npm run check`
(the gate), `npm run build` (dist/ + route-table.json + the
self-containment gate).
