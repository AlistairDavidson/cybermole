// /api/apps/:slug — PATCH renames and/or sets the cwd (the slug is stable
// once created, v1; cwd null clears it back to unset — task/app-cwd),
// DELETE cascades workspaces + terminals and un-tags jobs (§6). A slug
// that isn't APP_SLUG_RE is a 400 before the domain is reached.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import {
  appFailureResponse,
  failureResponse,
  invalidAppSlugResponse,
  jsonResponse,
} from '../../../lib/web/responses.service';
import { appPatchBody } from '../../../schemas/api';
import { AppSlugSchema } from '../../../schemas/ids';

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const slug = AppSlugSchema.safeParse(params.slug);
  if (!slug.success) return invalidAppSlugResponse();
  const parsed = await parseAndValidateAPIRequest(request, appPatchBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = await webpi.apps.renameApp(slug.data, parsed.data.name, parsed.data.cwd);
  if (!saved.ok) return appFailureResponse(saved);
  return jsonResponse(saved.data, 200);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { webpi } = assertWebPiLocals(locals);
  const slug = AppSlugSchema.safeParse(params.slug);
  if (!slug.success) return invalidAppSlugResponse();
  const deleted = await webpi.apps.deleteApp(slug.data);
  if (!deleted.ok) return appFailureResponse(deleted);
  return jsonResponse(deleted.data, 200);
};
