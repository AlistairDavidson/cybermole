// GET /api/management — the /management page's state: what this boot
// serves, the workspace checkout, the release history. Read-only; paths
// and shas only (docs/management-page.md §5).
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { jsonResponse, managementFailureResponse } from '../../../lib/web/responses.service';

export const GET: APIRoute = async ({ locals }) => {
  const { webpi } = assertWebPiLocals(locals);
  const state = await webpi.management.state();
  if (!state.ok) return managementFailureResponse(state);
  return jsonResponse(state.data, 200);
};
