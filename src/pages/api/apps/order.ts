// PUT persists a full-list reorder of the app groups: positions become
// steps of 10.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { appFailureResponse, failureResponse } from '../../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { appReorderBody } from '../../../schemas/api';

export const PUT: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, appReorderBody);
  if (!parsed.ok) return failureResponse(parsed);
  const reordered = await cybermole.apps.reorderApps(parsed.data.order);
  if (!reordered.ok) return appFailureResponse(reordered);
  cybermole.invalidateAppsStatus();
  return jsonResponse(reordered.data, 200);
};
