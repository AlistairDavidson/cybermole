// /api/apps/:slug — PATCH renames and/or sets the cwd (the slug is stable
// once created, v1; cwd null clears it back to unset — task/app-cwd),
// DELETE cascades workspaces + terminals and un-tags jobs (§6). A slug
// that isn't APP_SLUG_RE is a 400 before the domain is reached.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import {
  appFailureResponse,
  failureResponse,
  invalidAppSlugResponse,
} from '../../../lib/web/responses.service';
import { appPatchBody } from '../../../schemas/api';
import { jsonResponse, AppSlugSchema } from '@cybermole/app-kit';

export const PATCH: APIRoute = async ({ locals, params, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const slug = AppSlugSchema.safeParse(params.slug);
  if (!slug.success) return invalidAppSlugResponse();
  const parsed = await parseAndValidateAPIRequest(request, appPatchBody);
  if (!parsed.ok) return failureResponse(parsed);
  const saved = await cybermole.apps.renameApp(slug.data, parsed.data.name, parsed.data.cwd);
  if (!saved.ok) return appFailureResponse(saved);
  return jsonResponse(saved.data, 200);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const slug = AppSlugSchema.safeParse(params.slug);
  if (!slug.success) return invalidAppSlugResponse();
  const deleted = await cybermole.apps.deleteApp(slug.data);
  if (!deleted.ok) return appFailureResponse(deleted);
  return jsonResponse(deleted.data, 200);
};
