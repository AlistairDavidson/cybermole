// Every API method delegates to the kit's binder — the table owns the
// routes (apps-plan §5): method+path matching, zod parse, handler,
// Result→status. basePath is the app's baked base, so table entries name
// paths the way the app thinks of them ('/api/notes/:id') while the
// mounted URL is '/apps/notes/api/notes/:id'. This module is SERVER-ONLY
// (never in the islands' client graph), so it is also where the sqlite
// store is bound into the slot the table's handlers read (app-store.ts).
import { astroApiHandlers } from '@cybermole/app-kit/route-table';
import { routes } from '../../routes';
import { bindNotesStore } from '../../lib/app-store';
import { getAppDb } from '../../lib/notes-db';

bindNotesStore(getAppDb());

export const { GET, POST, PATCH, PUT, DELETE } = astroApiHandlers(routes, {
  basePath: import.meta.env.BASE_URL,
});
