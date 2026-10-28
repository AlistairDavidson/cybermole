---
name: cybermole-app
description: Use when scaffolding, extending, or refactoring a cybermole app (an Astro webapp under the apps root served at /apps/<slug>/).
---

# Building a cybermole app

Canonical sources — read them, don't expect them duplicated here: the
architecture is `docs/conventions/CODE_STYLE.md` §7 (Astro components +
HTML web component enhancers + `@preact/signals-core` stores; say
"component", never "island"), the tree layout is the app-starter README
(`runtime/app-starter/README.md`, scaffolded into every app), the substrate
is `packages/app-kit/README.md`.

## The loop (the root agent's, through the `cybermole-apps` MCP)

1. `scaffold` — the tree from the app-starter template: one example action
   wired end to end, its git repo, the operator's AGENTS.md.
2. `add_action` — one action = one route-table entry (`src/routes.ts`);
   generates the lib family + test stub + store + component directory +
   page section + the AGENTS.md block in lockstep.
3. Implement the Result family in `src/lib/<name>.ts`: closed error codes,
   `satisfies`, catch only at the boundary (CODE_STYLE.md §1–2); map codes
   to statuses on the entry's `errorStatus`.
4. Tests: one per error code, not just the happy path.
5. UI: a component directory `src/components/<Name>/` — `<Name>.astro` (the
   SSR, owning its wa-* SSR halves) + `<name>.ts` (the enhancer, owning
   `@cybermole/app-kit/wa-client` + its client halves); repeated markup is
   templated in the `.astro` (`<template data-item>`), never createElement'd
   (§7); live state in `src/store/<name>.ts`; every call through
   `createRouteClient` — the same code path the API and MCP tool serve.
6. `check` — the gate: typecheck + `lint:arch` + unit + build +
   self-containment. Re-run until green.
7. `register` + `reload` — the sync point that mounts the app.
8. e2e when page-level behavior changed: the tree's own `test:e2e`
   (console-side `apps-*` specs are the host's).

Never touch the tree's `data/` (the app's sqlite — user data). Live
updates: the WS is a doorbell (`createAppSocket`) — the frame bumps a
signal, an effect refetches through the route client and updates the DOM
surgically.
