// PUT persists a full-list reorder within one group (the console's or one
// app's): positions become steps of 10.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { failureResponse, workspaceFailureResponse } from '../../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { workspaceReorderBody } from '../../../schemas/api';

export const PUT: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, workspaceReorderBody);
  if (!parsed.ok) return failureResponse(parsed);
  const reordered = await cybermole.workspaces.reorderWorkspaces(parsed.data.order);
  if (!reordered.ok) return workspaceFailureResponse(reordered);
  return jsonResponse(reordered.data, 200);
};
