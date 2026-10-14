// /api/apps — POST creates an app (workspaces-plan §6). The name is any
// string; the domain slugs it (normalizeSlug) — normalization is not
// validation. A duplicate slug is 409, an unusable name 400.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { appFailureResponse, failureResponse, jsonResponse } from '../../../lib/web/responses.service';
import { appCreateBody } from '../../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, appCreateBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = await webpi.apps.saveApp(parsed.data.name);
  if (!saved.ok) return appFailureResponse(saved);
  return jsonResponse(saved.data, 200);
};
