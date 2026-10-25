// Every API method delegates to the kit's binder — the table owns the
// routes (apps-plan §5): method+path matching, zod parse, handler,
// Result→status. basePath is the app's baked base, so table entries name
// paths the way the app thinks of them ('/api/ping') while the mounted
// URL is '/apps/<slug>/api/ping'.
import { astroApiHandlers } from '@cybermole/app-kit/route-table';
import { routes } from '../../routes';

export const { GET, POST, PATCH, PUT, DELETE } = astroApiHandlers(routes, {
  basePath: import.meta.env.BASE_URL,
});
