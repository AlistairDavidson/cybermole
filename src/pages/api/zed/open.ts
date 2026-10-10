// POST /api/zed/open — the console's "open in Zed": forward a session's
// cwd to the launcher inside the zed container (src/lib/zed.ts), which
// opens it in the running Zed (or boots Zed with it). The stream itself
// is a separate origin (the reverse-proxied KasmVNC client at
// WEB_PI_ZED_URL) — the browser opens that tab directly; this endpoint
// only makes the folder appear in it.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../../lib/web/locals';
import { parseAndValidateAPIRequest } from '../../../lib/web/parsing.service';
import { failureResponse, jsonResponse, zedOpenFailureResponse } from '../../../lib/web/responses.service';
import { zedOpenBody } from '../../../schemas/api';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseAndValidateAPIRequest(request, zedOpenBody);
  if (!parsed.ok) return failureResponse(parsed);
  const opened = await webpi.openInZed(parsed.data.path);
  if (!opened.ok) return zedOpenFailureResponse(opened);
  return jsonResponse({ ok: true }, 200);
};
