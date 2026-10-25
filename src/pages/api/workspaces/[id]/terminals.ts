// POST opens a tab. A failed spawn still returns the row (live:false); the first attach retries.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../../lib/web/parsing.service';
import {
  failureResponse,
  invalidWorkspaceIdResponse,
  terminalFailureResponse,
} from '../../../../lib/web/responses.service';
import { terminalCreateBody } from '../../../../schemas/api';
import { jsonResponse, WorkspaceIdSchema } from '@cybermole/app-kit';

export const POST: APIRoute = async ({ locals, params, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const id = WorkspaceIdSchema.safeParse(params.id);
  if (!id.success) return invalidWorkspaceIdResponse();
  const parsed = await parseAndValidateAPIRequest(request, terminalCreateBody);
  if (!parsed.ok) return failureResponse(parsed);
  const created = await cybermole.workspaces.newTerminal(id.data, parsed.data.title);
  if (!created.ok) return terminalFailureResponse(created);
  return jsonResponse(created.data, 200);
};
