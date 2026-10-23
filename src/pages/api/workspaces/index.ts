// /api/workspaces — POST creates a workspace (workspaces-plan §6):
// appId null/absent = the console group. No cwd on the wire (task/app-cwd
// — "no folder setting when creating workspace: the app does that"): the
// domain derives it — the parent app's cwd when it has one, else
// CYBERMOLE_NEW_SESSION_CWD — and validates it absolute + existing dir.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import {
  failureResponse,
  jsonResponse,
  workspaceFailureResponse,
} from '../../../lib/web/responses.service';
import { workspaceCreateBody } from '../../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, workspaceCreateBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = await cybermole.workspaces.saveWorkspace(parsed.data);
  if (!saved.ok) return workspaceFailureResponse(saved);
  return jsonResponse(saved.data, 200);
};
