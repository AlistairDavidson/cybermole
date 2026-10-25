// THE route table — this app's single source of truth (apps-plan §2/§5):
// every action is ONE entry here, and the kit's binder gives it every
// face at once — the HTTP route (src/pages/api/[...path].ts), the typed
// client the UI uses (src/islands), the MCP shim's tools and
// dist/route-table.json (describe/call) — same Result JSON everywhere.
// The entries were appended by the add_action tool and then edited into
// the real vocabulary (note_create/note_list/note_get grew path-param and
// body shapes; note_edit flipped to PATCH); `npm run check` stays the
// gate.
//
// The schemas judge SHAPE only (string / array of strings / coerced
// number); everything a user can get wrong — empty titles, bounds, tag
// rules — is judged by the action's own family, so every face answers
// the same closed error codes (apps-plan §0).
import { z } from 'zod';
import { defineRoute, type RouteTable } from '@cybermole/app-kit/route-table';
import { pingResult } from './lib/ping';
import { noteCreateResult } from './lib/note_create';
import { noteListResult } from './lib/note_list';
import { noteGetResult } from './lib/note_get';
import { noteEditResult } from './lib/note_edit';
import { noteArchiveResult } from './lib/note_archive';
import { notesStore } from './lib/app-store';

export const routes: RouteTable = [
  defineRoute({
    name: 'ping',
    description: 'answers a hello — the scaffolded example action, wired end to end',
    method: 'GET',
    path: '/api/ping',
    params: z.object({}),
    query: z.object({
      name: z
        .string()
        .trim()
        .min(1, 'name is required')
        .max(64, 'name is too long (max 64 chars)'),
    }),
    errorStatus: { invalid_name: 400 },
    handler: ({ query }) => pingResult(query.name),
  }),
  defineRoute({
    name: 'note_create',
    description: 'capture a note — title, body and tags',
    method: 'POST',
    path: '/api/notes',
    params: z.object({}),
    body: z.object({
      title: z.string(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    errorStatus: { invalid_title: 400, invalid_body: 400, invalid_tags: 400, database_error: 500 },
    successStatus: 201,
    handler: ({ body }) => noteCreateResult(notesStore(), body),
  }),
  defineRoute({
    name: 'note_list',
    description: 'list notes — substring search, a tag filter, the archived flag (live notes only by default)',
    method: 'GET',
    path: '/api/notes',
    params: z.object({}),
    query: z.object({
      search: z.string().optional(),
      tag: z.string().optional(),
      archived: z.string().optional(),
    }),
    errorStatus: { invalid_archived: 400, database_error: 500 },
    handler: ({ query }) => noteListResult(notesStore(), query),
  }),
  defineRoute({
    name: 'note_get',
    description: 'one note by its id',
    method: 'GET',
    path: '/api/notes/:id',
    params: z.object({
      id: z.coerce.number().int().positive(),
    }),
    errorStatus: { note_not_found: 404, database_error: 500 },
    handler: ({ params }) => noteGetResult(notesStore(), params.id),
  }),
  defineRoute({
    name: 'note_edit',
    description: 'edit a note — any of title, body or tags, merged',
    method: 'PATCH',
    path: '/api/notes/:id',
    params: z.object({
      id: z.coerce.number().int().positive(),
    }),
    body: z.object({
      title: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    errorStatus: {
      note_not_found: 404,
      invalid_title: 400,
      invalid_body: 400,
      invalid_tags: 400,
      invalid_patch: 400,
      database_error: 500,
    },
    handler: ({ params, body }) => noteEditResult(notesStore(), params.id, body),
  }),
  defineRoute({
    name: 'note_archive',
    description: 'archive a note — a flag, never a delete',
    method: 'POST',
    path: '/api/notes/:id/archive',
    params: z.object({
      id: z.coerce.number().int().positive(),
    }),
    errorStatus: { note_not_found: 404, database_error: 500 },
    handler: ({ params }) => noteArchiveResult(notesStore(), params.id),
  }),
];
