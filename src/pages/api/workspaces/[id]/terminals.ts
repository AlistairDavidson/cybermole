// /api/workspaces/:id/terminals — POST opens a terminal tab (§6): the
// domain inserts the row (sort_order = max+10) and best-effort-spawns
// its tmux session (plan §4) — a failed spawn still returns the row
// (live:false, a dead tab; the first attach retries the spawn).
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../../lib/web/parsing.service';
import { failureResponse, invalidWorkspaceIdResponse, jsonResponse, terminalFailureResponse } from '../../../../lib/web/responses.service';
import { terminalCreateBody } from '../../../../schemas/api';
import { WorkspaceIdSchema } from '../../../../schemas/ids';

export const POST: APIRoute = async ({ locals, params, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const id = WorkspaceIdSchema.safeParse(params.id);
  if (!id.success) return invalidWorkspaceIdResponse();
  const parsed = await parseAndValidateAPIRequest(request, terminalCreateBody);
  if (!parsed.ok) return failureResponse(parsed);
  const created = await webpi.workspaces.newTerminal(id.data, parsed.data.title);
  if (!created.ok) return terminalFailureResponse(created);
  return jsonResponse(created.data, 200);
};
