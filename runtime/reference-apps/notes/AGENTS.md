# AGENTS.md — operating Notes

capture, find, and archive notes and standup journals

This is a cybermole app: an Astro webapp the cybermole app host serves
behind the console's login at `/apps/notes/` (the console sidebar's
app group links it). You are the OPERATOR's agent — the app's user, not
its builder. Building, extending and re-deploying the app itself is the
root agent's job through the `cybermole-apps` MCP; it is disabled in this
tree on purpose (operators don't scaffold — the role boundary is tool
availability, apps-plan §7). Use the app's own MCP tools (registered
under the app's slug by this tree's `.pi/mcp.json`) to act on the user's
behalf; the human does the same through the app's pages.

- name: Notes
- mount: `/apps/notes/` — serving only while the app is registered
  AND built; if a page 404s, the app needs a `register` + `reload` from a
  root agent, not debugging from here.
- tree: this directory — its own git repo (`git log`/`git diff` for
  history; the scaffold made the first commit). `data/` holds the app's
  own sqlite database and is gitignored: NEVER commit, move or "clean" it
  — it is the user's data.
- the actions live in `src/routes.ts` (the route table) — every tool
  below is one table entry, the same one the app's pages call.

## What this app is for

The reference app of the apps epic (built
through the verbs, the build loop's acceptance run): a small honest
notes/journal. Capture a note with a title, a body and tags; find them
again by search, by tag, or by browsing; keep the standup journal in
tags (a `standup` tag per entry is the convention this tree was built
around); archive what is done — the archive hides a note from the
default list and keeps every byte of it. Every face answers the same
Result JSON: the pages (`/apps/notes/`), the tools below, and the root
agent's `describe`/`call`.

## Actions

One section per action, REGENERATED from `src/routes.ts` by the scaffold
and by `add_action` — edit around this block, never in it (a regenerated
block wins; the manual cannot drift from the code).

<!-- BEGIN ACTIONS (generated from src/routes.ts — do not edit inside) -->
### ping

answers a hello — the scaffolded example action, wired end to end
- call: the `ping` MCP tool, or the page's ping affordance, or `GET /apps/notes/api/ping`
- input: `name` (string, required)

### note_create

capture a note — title, body and tags
- call: the `note_create` MCP tool, or the page's note_create affordance, or `POST /apps/notes/api/notes`
- input: `title` (string, required), `body` (string, optional), `tags` (string, optional)
- ui: requires JS (a JSON body — no native-form fallback)

### note_list

list notes — substring search, a tag filter, the archived flag (live notes only by default)
- call: the `note_list` MCP tool, or the page's note_list affordance, or `GET /apps/notes/api/notes`
- input: `search` (string, optional), `tag` (string, optional), `archived` (string, optional)

### note_get

one note by its id
- call: the `note_get` MCP tool, or the page's note_get affordance, or `GET /apps/notes/api/notes/:id`
- input: `id` (number, required)

### note_edit

edit a note — any of title, body or tags, merged
- call: the `note_edit` MCP tool, or the page's note_edit affordance, or `PATCH /apps/notes/api/notes/:id`
- input: `id` (number, required), `title` (string, optional), `body` (string, optional), `tags` (string, optional)
- ui: requires JS (a JSON body — no native-form fallback)

### note_archive

archive a note — a flag, never a delete
- call: the `note_archive` MCP tool, or the page's note_archive affordance, or `POST /apps/notes/api/notes/:id/archive`
- input: `id` (number, required)
- ui: requires JS (a JSON body — no native-form fallback)
<!-- END ACTIONS -->

Tags are lowercase, comma-free, at most ten per note; `note_list`'s
`archived` takes exactly `"true"`/`"false"` (anything else answers
`invalid_archived`). Notes list newest-first, capped at 200.

## Policy

- **Archive, never delete.** Anything that removes the user's data
  (rows, files, the data/ db) is destructive: prefer the app's
  archive-style action when one exists, and never drop what an archive
  could keep. `note_archive` is this app's ONLY removal-adjacent action,
  and its whole blast radius is one boolean on one note: the note keeps
  its title, body, tags and timestamps, leaves the default list, and
  answers `note_list` with `archived=true`. Nothing this app can do
  loses a byte — keep it that way.
- **Confirm destructive calls.** Ask before any action whose name or
  effect is destructive (delete, drop, purge, overwrite-many) — show the
  user what will be touched and let them say go. `note_archive` and
  `note_edit` touch exactly the one note they name (and archive is
  reversible in the data, if not yet in the vocabulary); there is no
  bulk action to confirm.
- Actions that fail answer their Result JSON (`ok:false`, an
  `errorCode`/`error`) — read it, don't retry blind; a `transport_error`
  means the app host is unreachable (tell the user, don't hammer it).
- Code changes in this tree belong to the root agent: report what you
  found, don't edit `src/` from an operator session. `npm run check` in
  the tree is the same gate the root agent's check tool runs.
