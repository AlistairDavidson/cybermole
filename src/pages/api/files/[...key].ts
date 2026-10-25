// GET /api/files/<key>: streams a stored file from object storage, always as
// an attachment. A single Range (with If-Range) passes through for resumes.
// HEAD has its own handler: Astro would otherwise run GET and leave an S3
// download open per HEAD.
import type { APIRoute } from 'astro';
import { assertCybermoleLocals } from '../../../lib/web/locals';
import { parseRangeRequest } from '../../../lib/web/parsing.service';
import {
  fileDownloadResponse,
  fileHeadResponse,
  invalidObjectKeyResponse,
  objectStoreFailureResponse,
} from '../../../lib/web/responses.service';
import { ObjectKeySchema } from '@cybermole/app-kit';

export const GET: APIRoute = async ({ locals, params, request }) => {
  const { cybermole } = assertCybermoleLocals(locals);
  const key = ObjectKeySchema.safeParse(params.key);
  if (!key.success) return invalidObjectKeyResponse();
  const fetched = await cybermole.objectStore.fetchObject(
    key.data,
    parseRangeRequest(request.headers),
  );
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
