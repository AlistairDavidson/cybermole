// PUT persists a full-list tab reorder: positions become steps of 10.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../../../lib/web/parsing.service';
import {
  failureResponse,
  invalidWorkspaceIdResponse,
  terminalFailureResponse,
} from '../../../../../lib/web/responses.service';
import { terminalReorderBody } from '../../../../../schemas/api';
import { jsonResponse, WorkspaceIdSchema } from '@cybermole/app-kit';

export const PUT: APIRoute = async ({ locals, params, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const id = WorkspaceIdSchema.safeParse(params.id);
  if (!id.success) return invalidWorkspaceIdResponse();
  const parsed = await parseAndValidateAPIRequest(request, terminalReorderBody);
  if (!parsed.ok) return failureResponse(parsed);
  const reordered = await cybermole.workspaces.reorderTerminals(id.data, parsed.data.order);
  if (!reordered.ok) return terminalFailureResponse(reordered);
  return jsonResponse(reordered.data, 200);
};
