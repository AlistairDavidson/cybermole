// The table owns every API route. basePath is the baked base, so entries
// name '/api/ping' while the mounted URL is '/apps/<slug>/api/ping'.
import { astroApiHandlers } from '@cybermole/app-kit/route-table';
import { routes } from '../../routes';

export const { GET, POST, PATCH, PUT, DELETE } = astroApiHandlers(routes, {
  basePath: import.meta.env.BASE_URL,
});
