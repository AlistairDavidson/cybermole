// POST /api/management/activate — the swap/rollback: point the next boot
// at a built release (target: sha) or the image copy (target: 'image'),
// record it, and restart the server through its graceful shutdown path.
// Guards: password re-confirmation, the enforcement re-run for a release
// target, the release must exist and match its manifest
// (docs/management-page.md §3).
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { failureResponse, jsonResponse, managementFailureResponse } from '../../../lib/web/responses.service';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { ManagementActivateSchema } from '../../../schemas/management';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, ManagementActivateSchema);
  if (!parsed.ok) return failureResponse(parsed);
  const activated = await webpi.management.activate(parsed.data);
  if (!activated.ok) return managementFailureResponse(activated);
  return jsonResponse(activated.data, 202);
};
