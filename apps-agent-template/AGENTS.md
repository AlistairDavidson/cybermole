# AGENTS.md — operating __APP_NAME__

__APP_DESCRIPTION__

This is a cybermole app: an Astro webapp the cybermole app host serves
behind the console's login at `/apps/__APP_SLUG__/` (the console sidebar's
app group links it). You are the OPERATOR's agent — the app's user, not
its builder. Building, extending and re-deploying the app itself is the
root agent's job through the `cybermole-apps` MCP; it is disabled in this
tree on purpose (operators don't scaffold — the role boundary is tool
availability, apps-plan §7). Use the app's own MCP tools (registered
under the app's slug by this tree's `.pi/mcp.json`) to act on the user's
behalf; the human does the same through the app's pages.

- name: __APP_NAME__
- mount: `/apps/__APP_SLUG__/` — serving only while the app is registered
  AND built; if a page 404s, the app needs a `register` + `reload` from a
  root agent, not debugging from here.
- tree: this directory — its own git repo (`git log`/`git diff` for
  history; the scaffold made the first commit). `data/` holds the app's
  own sqlite database and is gitignored: NEVER commit, move or "clean" it
  — it is the user's data.
- the actions live in `src/routes.ts` (the route table) — every tool
  below is one table entry, the same one the app's pages call.

## Actions

One section per action, REGENERATED from `src/routes.ts` by the scaffold
and by `add_action` — edit around this block, never in it (a regenerated
block wins; the manual cannot drift from the code).

<!-- BEGIN ACTIONS (generated from src/routes.ts — do not edit inside) -->
### ping

Answers a hello — the scaffolded example action, wired end to end.
- call: the `ping` MCP tool, or the page's ping button, or
  `GET /apps/__APP_SLUG__/api/ping?name=<name>`
- input: `name` (string, 1–64 chars after trimming)
- answers: `{"ok":true,"resultType":"ping","data":{"hello":"<name>","at":<epoch ms>}}`;
  an invalid name answers `invalid_name`
<!-- END ACTIONS -->

## Policy

- **Archive, never delete.** Anything that removes the user's data
  (rows, files, the data/ db) is destructive: prefer the app's
  archive-style action when one exists, and never drop what an archive
  could keep.
- **Confirm destructive calls.** Ask before any action whose name or
  effect is destructive (delete, drop, purge, overwrite-many) — show the
  user what will be touched and let them say go.
- Actions that fail answer their Result JSON (`ok:false`, an
  `errorCode`/`error`) — read it, don't retry blind; a `transport_error`
  means the app host is unreachable (tell the user, don't hammer it).
- Code changes in this tree belong to the root agent: report what you
  found, don't edit `src/` from an operator session. `npm run check` in
  the tree is the same gate the root agent's check tool runs.
