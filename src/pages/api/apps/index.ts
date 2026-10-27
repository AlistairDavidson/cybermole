// POST creates an app; the domain derives the slug from the name.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { appFailureResponse, failureResponse } from '../../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { appCreateBody } from '../../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, appCreateBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = await cybermole.apps.saveApp(parsed.data.name, parsed.data.cwd, parsed.data.icon);
  if (!saved.ok) return appFailureResponse(saved);
  cybermole.invalidateAppsStatus();
  return jsonResponse(saved.data, 200);
};
