// GET /api/files/<key> — download a file POST /api/files stored (key =
// uploads/<uuid>, as that answered). Streams from object storage; always
// served as an attachment (downloadHeaders in responses.service.ts has
// the why). Resumable: a single-range Range header (with If-Range) is
// passed through to S3 — 206 with Content-Range, 416 past the end.
// HEAD has its own handler: Astro would otherwise run GET and drop its
// body unread, leaving an S3 download open per HEAD.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseRangeRequest } from '../../../lib/web/parsing.service';
import {
  fileDownloadResponse,
  fileHeadResponse,
  invalidObjectKeyResponse,
  objectStoreFailureResponse,
} from '../../../lib/web/responses.service';
import { ObjectKeySchema } from '../../../schemas/ids';

export const GET: APIRoute = async ({ locals, params, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const key = ObjectKeySchema.safeParse(params.key);
  if (!key.success) return invalidObjectKeyResponse();
  const fetched = await cybermole.objectStore.fetchObject(key.data, parseRangeRequest(request.headers));
  if (!fetched.ok) return objectStoreFailureResponse(fetched);
  return fileDownloadResponse(fetched.data);
};

export const HEAD: APIRoute = async ({ locals, params }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const key = ObjectKeySchema.safeParse(params.key);
  if (!key.success) return invalidObjectKeyResponse();
  const info = await cybermole.objectStore.statObject(key.data);
  if (!info.ok) return objectStoreFailureResponse(info);
  return fileHeadResponse(info.data);
};
