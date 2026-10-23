// /api/workspaces/:id — PATCH renames/moves the cwd, DELETE cascades its
// terminals (killing their tmux sessions best-effort) — §6. An id that
// isn't one of our uuid v4s is a 400 before the domain is reached.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import {
  failureResponse,
  invalidWorkspaceIdResponse,
  jsonResponse,
  workspaceFailureResponse,
} from '../../../lib/web/responses.service';
import { workspacePatchBody } from '../../../schemas/api';
import { WorkspaceIdSchema } from '../../../schemas/ids';

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const id = WorkspaceIdSchema.safeParse(params.id);
  if (!id.success) return invalidWorkspaceIdResponse();
  const parsed = await parseAndValidateAPIRequest(request, workspacePatchBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = await cybermole.workspaces.updateWorkspace(id.data, parsed.data);
  if (!saved.ok) return workspaceFailureResponse(saved);
  return jsonResponse(saved.data, 200);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const id = WorkspaceIdSchema.safeParse(params.id);
  if (!id.success) return invalidWorkspaceIdResponse();
  const deleted = await cybermole.workspaces.deleteWorkspace(id.data);
  if (!deleted.ok) return workspaceFailureResponse(deleted);
  return jsonResponse(deleted.data, 200);
};
