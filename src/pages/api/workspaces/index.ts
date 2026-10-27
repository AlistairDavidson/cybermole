// POST creates a workspace (appId null = the console group). The cwd is
// optional: absent or empty derives it (the parent app's, else
// CYBERMOLE_NEW_SESSION_CWD). The name is optional the same way: absent or
// empty derives it from the resolved cwd's basename, uniquified per group.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { failureResponse, workspaceFailureResponse } from '../../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
import { workspaceCreateBody } from '../../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, workspaceCreateBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = await cybermole.workspaces.saveWorkspace(parsed.data);
  if (!saved.ok) return workspaceFailureResponse(saved);
  return jsonResponse(saved.data, 200);
};
