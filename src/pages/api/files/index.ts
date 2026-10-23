// POST /api/files — store one uploaded file in object storage and answer
// its key (201); GET /api/files/<key> ([...key].ts) serves it back.
// multipart/form-data, the file in field "file"; the policy (size, types)
// is src/schemas/uploads.ts. The file streams from the request straight
// into storage — never held in memory whole. The only route whose body may
// pass the JSON API's 10 KiB: server/main.ts's per-route cap and the
// adapter's bodySizeLimit (astro.config.mjs) both allow it
// UPLOAD_MAX_BODY_BYTES, and main.ts trades its whole-request deadline
// for a stall timeout here.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { streamFileUpload } from '../../../lib/web/parsing.service';
import {
  failureResponse,
  jsonResponse,
  objectStoreFailureResponse,
} from '../../../lib/web/responses.service';
import { UPLOAD_ALLOWED_MIME_TYPES, UPLOAD_MAX_FILE_BYTES } from '../../../schemas/uploads';

export const POST: APIRoute = async ({ locals, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const stored = await streamFileUpload(
    request,
    { maxSize: UPLOAD_MAX_FILE_BYTES, allowedMimeTypes: UPLOAD_ALLOWED_MIME_TYPES },
    file =>
      cybermole.objectStore.storeUpload({
        name: file.name,
        contentType: file.contentType,
        body: file.stream,
      }),
  );
  if (!stored.ok)
    return stored.resultType === 'file_upload'
      ? failureResponse(stored)
      : objectStoreFailureResponse(stored);
  return jsonResponse(stored.data, 201);
};
