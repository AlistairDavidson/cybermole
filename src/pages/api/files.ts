// POST /api/files — store one uploaded file in object storage and answer
// its key (201). multipart/form-data, the file in field "file"; the policy
// (size, types) is src/schemas/uploads.ts. The only route whose body may
// pass the JSON API's 10 KiB: server/main.ts's per-route cap and the
// adapter's bodySizeLimit (astro.config.mjs) both allow it
// UPLOAD_MAX_BODY_BYTES.
import type { APIRoute } from 'astro';
import { assertWebPiLocals } from '../../lib/web/locals';
import { parseFileUpload } from '../../lib/web/parsing.service';
import { failureResponse, jsonResponse, storeUploadFailureResponse } from '../../lib/web/responses.service';
import { UPLOAD_ALLOWED_MIME_TYPES, UPLOAD_MAX_FILE_BYTES } from '../../schemas/uploads';

export const POST: APIRoute = async ({ locals, request }) => {
  const { webpi } = assertWebPiLocals(locals);
  const parsed = await parseFileUpload(request, {
    maxSize: UPLOAD_MAX_FILE_BYTES,
    allowedMimeTypes: UPLOAD_ALLOWED_MIME_TYPES,
  });
  if (!parsed.ok) return failureResponse(parsed);
  const { file, buffer } = parsed.data;
  const stored = await webpi.objectStore.storeUpload({ name: file.name, contentType: file.type, body: buffer });
  if (!stored.ok) return storeUploadFailureResponse(stored);
  return jsonResponse(stored.data, 201);
};
