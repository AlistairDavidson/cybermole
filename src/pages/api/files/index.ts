// POST /api/files: streams the multipart "file" field into object storage
// and answers its key (201). The only route allowed past the JSON API's
// 10 KiB body cap.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { streamFileUpload } from '../../../lib/web/parsing.service';
import { failureResponse, objectStoreFailureResponse } from '../../../lib/web/responses.service';
import { jsonResponse } from '@cybermole/app-kit';
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
