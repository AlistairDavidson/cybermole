// GET /api/management/commits — recent commits of the workspace checkout,
// for the picker. Read-only git on the :ro mount.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { jsonResponse, managementFailureResponse } from '../../../lib/web/responses.service';

export const GET: APIRoute = async ({ locals }) => {
  const { webpi } = assertWebPiLocals(locals);
  const listed = await webpi.management.commits();
  if (!listed.ok) return managementFailureResponse(listed);
  return jsonResponse(listed.data, 200);
};
