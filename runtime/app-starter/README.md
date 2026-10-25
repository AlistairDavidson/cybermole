# a cybermole app, scaffolded

This tree is a cybermole app (docs/plans/apps-plan.md — the image's app-starter
template, baked by the `cybermole-apps` scaffold): an Astro SSR webapp on
`@cybermole/app-kit`, served by the cybermole app host at `/apps/<slug>/`
behind the console's login once it is registered and built.

- `src/routes.ts` — THE route table: every action is one entry, bound by
  the kit to the HTTP route (`src/pages/api/[...path].ts`), the typed
  client the island uses, the MCP shim's tools and `dist/route-table.json`
  (emitted by the build — `astro.config.mjs`'s emit integration).
- `src/lib/` — the app's domain code (one Result family per concern);
  `data/` — the app's own sqlite (gitignored).
- `scripts/setup-node-modules.mjs` — the per-package node_modules symlinks
  into the install's tree (re-run after an image upgrade).
- `scripts/check-selfcontained.mjs` — the §5 build gate; `npm run build`
  runs it (the built entry must import nothing but node: builtins and
  relative chunks).

## The loop

```sh
npm run setup     # once (and after image upgrades): link the core stack
npm run check     # THE gate: astro check + tsc + unit tests + build
npm run build     # the build half alone (route-table.json + self-containment gate)
npm run test      # just the unit tests
```

The same loop runs through the root agent's `cybermole-apps` MCP
(`add_action`/`check`/`build`/`register`/`reload`) — this tree's `.pi/mcp.json`
disables that MCP on purpose (operators don't scaffold) and registers the
app's own action tools under the app's slug: the shim binary
(`<install>/dist-server/server/app-mcp-shim.js <slug>`), its tools 1:1 with
`dist/route-table.json`.

`AGENTS.md` in this tree is the operator's manual for agents working
here — read it first.
