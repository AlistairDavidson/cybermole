// The builder page's app portfolio: rows × mounted × built/stale, plus
// unregistered trees — the same join the status tool shapes, cached
// server-side (~10 s) so the 15 s poll cannot storm the fs.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { appsStatusFailureResponse } from '../../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';

export const GET: APIRoute = async ({ locals }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const status = await cybermole.appsStatus();
  if (!status.ok) return appsStatusFailureResponse(status);
  return jsonResponse(status.data, 200);
};
