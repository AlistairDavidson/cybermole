// GET /api/management/preview?sha=… — the dry-run enforcement verdict for
// one target commit, BEFORE any verb: what the diff base→target changes
// and whether it touches the protected set (docs/management-page.md §1).
// The same check re-runs server-side before build and activate; this view
// is information for the human, never the gate.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import {
  failureResponse,
  jsonResponse,
  managementFailureResponse,
} from '../../../lib/web/responses.service';
import { PreviewQuerySchema } from '../../../schemas/management';
import { parseZod } from '../../../lib/web/parsing.service';

export const GET: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = parseZod(
    { sha: new URL(request.url).searchParams.get('sha') },
    PreviewQuerySchema,
  );
  if (!parsed.ok) return failureResponse(parsed);
  const verdict = await webpi.management.preview(parsed.data.sha);
  if (!verdict.ok) return managementFailureResponse(verdict);
  return jsonResponse(verdict.data, 200);
};
