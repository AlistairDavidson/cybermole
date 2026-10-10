// POST /api/management/build — request a build of one commit. Guards:
// password re-confirmation, the enforcement re-run (the protected set
// must be untouched), one build at a time, the releases volume mounted
// (docs/management-page.md §1.6, §2). The BUILD runs in the builder
// sidecar (workspace-side); this only writes the request marker.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { failureResponse, jsonResponse, managementFailureResponse } from '../../../lib/web/responses.service';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { ManagementBuildSchema } from '../../../schemas/management';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, ManagementBuildSchema);
  if (!parsed.ok) return failureResponse(parsed);
  const requested = await webpi.management.requestBuild(parsed.data);
  if (!requested.ok) return managementFailureResponse(requested);
  return jsonResponse(requested.data, 202);
};
