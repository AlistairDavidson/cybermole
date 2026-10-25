// PATCH renames the tab (null clears to "term N"); DELETE closes it and kills its session.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import {
  failureResponse,
  invalidTerminalIdResponse,
  terminalFailureResponse,
} from '../../../lib/web/responses.service';
import { terminalPatchBody } from '../../../schemas/api';
import { jsonResponse, TerminalIdSchema } from '@cybermole/app-kit';

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const id = TerminalIdSchema.safeParse(params.id);
  if (!id.success) return invalidTerminalIdResponse();
  const parsed = await parseAndValidateAPIRequest(request, terminalPatchBody);
  if (!parsed.ok) return failureResponse(parsed);
  const renamed = await cybermole.workspaces.renameTerminal(id.data, parsed.data.title);
  if (!renamed.ok) return terminalFailureResponse(renamed);
  return jsonResponse(renamed.data, 200);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const id = TerminalIdSchema.safeParse(params.id);
  if (!id.success) return invalidTerminalIdResponse();
  const closed = await cybermole.workspaces.closeTerminal(id.data);
  if (!closed.ok) return terminalFailureResponse(closed);
  return jsonResponse(closed.data, 200);
};
