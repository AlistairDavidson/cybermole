// /api/terminals/:id — PATCH renames the tab (title null clears it back
// to the "term N" label), DELETE closes it (row + best-effort tmux kill,
// §6). An id that isn't one of our uuid v4s is a 400 first.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { failureResponse, invalidTerminalIdResponse, jsonResponse, terminalFailureResponse } from '../../../lib/web/responses.service';
import { terminalPatchBody } from '../../../schemas/api';
import { TerminalIdSchema } from '../../../schemas/ids';

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const id = TerminalIdSchema.safeParse(params.id);
  if (!id.success) return invalidTerminalIdResponse();
  const parsed = await parseAndValidateAPIRequest(request, terminalPatchBody);
  if (!parsed.ok) return failureResponse(parsed);
  const renamed = await webpi.workspaces.renameTerminal(id.data, parsed.data.title);
  if (!renamed.ok) return terminalFailureResponse(renamed);
  return jsonResponse(renamed.data, 200);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { webpi } = assertWebPiLocals(locals);
  const id = TerminalIdSchema.safeParse(params.id);
  if (!id.success) return invalidTerminalIdResponse();
  const closed = await webpi.workspaces.closeTerminal(id.data);
  if (!closed.ok) return terminalFailureResponse(closed);
  return jsonResponse(closed.data, 200);
};
