// The table owns every API route. basePath is the baked base, so entries
// name '/api/notes/:id' while the mounted URL is '/apps/notes/api/notes/:id'.
// Server-only, so this is also where the sqlite store gets bound.
import { astroApiHandlers } from '@cybermole/app-kit/route-table';
import { routes } from '../../routes';
import { bindNotesStore } from '../../lib/app-store';
import { getAppDb } from '../../lib/notes-db';

bindNotesStore(getAppDb());

export const { GET, POST, PATCH, PUT, DELETE } = astroApiHandlers(routes, {
  basePath: import.meta.env.BASE_URL,
});
