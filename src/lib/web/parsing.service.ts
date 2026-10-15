// parsing.service.ts — request parsing + zod validation as Results (from
// soothing-booking's src/services/web/parsing.service.ts, with its
// failure-to-errors fallthrough and ValidationResult alias fixed). API
// routes call parseAndValidateAPIRequest; failures map to responses with
// failureResponse (responses.service.ts). Imports `zod`, not `astro/zod`:
// this module is also compiled by the plain-tsc server build (and unit-
// tested there).
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Busboy, type BusboyFileStream, type BusboyInstance } from '@fastify/busboy';
import type { z, ZodType } from 'zod';
import type { ObjectRange } from '../storage';
import type { ResultFailure, ResultSuccess } from '../../types/result';

export type ParseSuccess<DataType extends object> = ResultSuccess<'parse_request', DataType>;
export type ParseErrorCode = 'unsupported_content_type' | 'invalid_json' | 'invalid_form_data';
export type ParseFailure<DataType extends object> = ResultFailure<
  'parse_request',
  DataType,
  ParseErrorCode
>;
export type ParseResult<DataType extends object> = ParseSuccess<DataType> | ParseFailure<DataType>;

export type ValidationSuccess<DataType extends object> = ResultSuccess<'validation', DataType>;
export type ValidationErrorCode = 'validation_failure';
export type ValidationFailureData = {
  issues: Record<string, string>;
};
export type ValidationFailure<DataType extends object> = ResultFailure<
  'validation',
  DataType,
  ValidationErrorCode
> &
  ValidationFailureData;
export type ValidationResult<DataType extends object> =
  ValidationSuccess<DataType> | ValidationFailure<DataType>;

export type FileUploadSuccess = ResultSuccess<'file_upload', ParsedUpload>;
export type FileUploadErrorCode =
  | 'unsupported_content_type'
  | 'invalid_form_data'
  | 'unsupported_file_type'
  | 'file_too_large'
  | 'no_file_provided';
export type FileUploadFailure = ResultFailure<'file_upload', ParsedUpload, FileUploadErrorCode>;
export type FileUploadResult = FileUploadSuccess | FileUploadFailure;

/** Basic Request Parsers **/
export async function parseAPIRequest<DataType extends object>(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    return parseJSON<DataType>(request);
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    return parseForm<DataType>(request);
  } else {
    return {
      ok: false,
      resultType: 'parse_request',
      errorCode: 'unsupported_content_type',
    } satisfies ParseFailure<DataType>;
  }
}
export type ParseAPIRequestResult<DataType extends object> = Awaited<
  ReturnType<typeof parseAPIRequest<DataType>>
>;

export async function parseFormPost<DataType extends object>(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  const is_form_post =
    contentType.includes('application/x-www-form-urlencoded') && request.method === 'POST';

  if (!is_form_post) {
    return {
      ok: false,
      resultType: 'parse_request',
      errorCode: 'unsupported_content_type',
    } satisfies ParseFailure<DataType>;
  }

  return parseForm<DataType>(request);
}
export type ParseFormPostResult<DataType extends object> = Awaited<
  ReturnType<typeof parseFormPost<DataType>>
>;

export async function parseJSON<DataType extends object>(request: Request) {
  try {
    return {
      ok: true,
      resultType: 'parse_request',
      data: (await request.json()) as DataType,
    } satisfies ParseSuccess<DataType>;
  } catch {
    // Also the oversized-body path: the adapter's bodySizeLimit aborts the
    // stream mid-read, which surfaces here as a failed parse.
    return {
      ok: false,
      resultType: 'parse_request',
      errorCode: 'invalid_json',
    } satisfies ParseFailure<DataType>;
  }
}

export async function parseForm<DataType extends object>(request: Request) {
  try {
    const formData = await request.formData();
    return {
      ok: true,
      resultType: 'parse_request',
      data: Object.fromEntries(formData.entries()) as unknown as DataType,
    } satisfies ParseSuccess<DataType>;
  } catch {
    return {
      ok: false,
      resultType: 'parse_request',
      errorCode: 'invalid_form_data',
    } satisfies ParseFailure<DataType>;
  }
}

/** Request parsers with Zod validation */

export async function parseAndValidateFormPost<DataType extends object>(
  request: Request,
  schema: ZodType<DataType>,
) {
  const parseResult = await parseFormPost<DataType>(request);
  if (!parseResult.ok) {
    return parseResult;
  }

  return parseZod<DataType>(parseResult.data, schema);
}
export type ParseAndValidateFormPostResult<DataType extends object> = Awaited<
  ReturnType<typeof parseAndValidateFormPost<DataType>>
>;
export type ParseAndValidateFormPostFailure<DataType extends object> = Extract<
  ParseAndValidateFormPostResult<DataType>,
  { ok: false }
>;

export async function parseAndValidateAPIRequest<DataType extends object>(
  request: Request,
  schema: z.ZodType<DataType>,
) {
  const parseResult = await parseAPIRequest<DataType>(request);
  if (!parseResult.ok) {
    return parseResult;
  }

  return parseZod<DataType>(parseResult.data, schema);
}
export type ParseAndValidateAPIRequestResult<DataType extends object> = Awaited<
  ReturnType<typeof parseAndValidateAPIRequest<DataType>>
>;

/** Validate a value against a schema: per-field issues (first issue per
 *  field, keyed by its dotted path; "" for the root) on failure. */
export function parseZod<DataType extends object>(data: unknown, schema: z.ZodType<DataType>) {
  const zodSafeParseResult = schema.safeParse(data);

  if (!zodSafeParseResult.success) {
    const issues: Record<string, string> = {};
    for (const issue of zodSafeParseResult.error.issues) {
      const field = issue.path.map(String).join('.');
      if (!issues[field]) {
        issues[field] = issue.message;
      }
    }
    return {
      ok: false,
      resultType: 'validation',
      errorCode: 'validation_failure',
      errorMessage: 'Failed validation',
      issues,
    } satisfies ValidationFailure<DataType>;
  }

  return {
    ok: true,
    resultType: 'validation',
    data: zodSafeParseResult.data,
  } satisfies ValidationSuccess<DataType>;
}

/** File upload parser */

export interface FileUploadOptions {
  fieldName?: string;
  maxSize: number;
  allowedMimeTypes: readonly string[];
}

export interface ParsedUpload {
  file: File;
  buffer: Buffer;
}

/** "5 GiB", "10 MiB", "512 KiB" — for the too-large message. */
function formatBytes(bytes: number): string {
  const units = ['KiB', 'MiB', 'GiB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${Number(value.toFixed(1))} ${unit}`;
}

function fileTooLarge(maxSize: number) {
  return {
    ok: false,
    resultType: 'file_upload',
    errorCode: 'file_too_large',
    errorMessage: `File too large, max size is ${formatBytes(maxSize)}`,
  } satisfies FileUploadFailure;
}

function unsupportedFileType(allowedMimeTypes: readonly string[]) {
  return {
    ok: false,
    resultType: 'file_upload',
    errorCode: 'unsupported_file_type',
    errorMessage: `Unsupported file type, supported types are ${allowedMimeTypes.join(', ')}`,
  } satisfies FileUploadFailure;
}

/** Buffered: the whole body in memory (request.formData()), then the
 *  file as a Buffer — for small files alongside other form logic. Large
 *  files go through streamFileUpload below. */
export async function parseFileUpload(request: Request, options: FileUploadOptions) {
  const contentType = request.headers.get('content-type') ?? '';
  const is_multipart = contentType.includes('multipart/form-data');

  if (!is_multipart) {
    return {
      ok: false,
      resultType: 'file_upload',
      errorCode: 'unsupported_content_type',
    } satisfies FileUploadFailure;
  }

  const fieldName = options.fieldName ?? 'file';
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return {
      ok: false,
      resultType: 'file_upload',
      errorCode: 'invalid_form_data',
      errorMessage: 'Invalid multipart body',
    } satisfies FileUploadFailure;
  }
  const file = formData.get(fieldName);

  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      resultType: 'file_upload',
      errorCode: 'no_file_provided',
    } satisfies FileUploadFailure;
  }

  if (file.size > options.maxSize) {
    return fileTooLarge(options.maxSize);
  }

  const is_allowed_type = options.allowedMimeTypes.includes(file.type);
  if (!is_allowed_type) {
    return unsupportedFileType(options.allowedMimeTypes);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return {
    ok: true,
    resultType: 'file_upload',
    data: { file, buffer },
  } satisfies FileUploadSuccess;
}

/** One file, streamed: the parser hands it to a sink as it arrives, so
 *  memory stays flat whatever the size. */
export interface FileUploadStream {
  /** the client's file name (a part with an empty one is no file) */
  name: string;
  /** the declared type, already checked against allowedMimeTypes */
  contentType: string;
  /** the file's bytes. Ends cleanly only if the whole file arrived within
   *  maxSize; a cut-short or oversized upload destroys it with an error,
   *  so a sink never stores a truncated file as if it were complete. */
  stream: Readable;
}

/** Where a streamed file goes (object storage, in POST /api/files). It
 *  must settle once the stream ends or errors, and catch its own failures:
 *  it is called at a boundary. */
export type FileUploadSink<SinkResult extends { ok: boolean }> = (
  file: FileUploadStream,
) => Promise<SinkResult>;

/** Parse a multipart upload as it streams in (busboy) and pipe its file
 *  part — field `fieldName`, the first one — into `sink`. The declared type
 *  is checked before the sink sees a byte; the size while it streams.
 *  Answers the sink's result, or a FileUploadFailure for the upload itself
 *  — which wins over the sink's own failure it caused (an oversized file
 *  makes the sink's write fail; the answer is still file_too_large).
 *
 *  On a failure the rest of the body is read and discarded rather than the
 *  request torn down: cancelling it would reset the connection, and the
 *  client would see a network error instead of the answer. */
export function streamFileUpload<SinkResult extends { ok: boolean }>(
  request: Request,
  options: FileUploadOptions,
  sink: FileUploadSink<SinkResult>,
): Promise<SinkResult | FileUploadFailure> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return Promise.resolve({
      ok: false,
      resultType: 'file_upload',
      errorCode: 'unsupported_content_type',
    } satisfies FileUploadFailure);
  }
  const invalidBody = {
    ok: false,
    resultType: 'file_upload',
    errorCode: 'invalid_form_data',
    errorMessage: 'Invalid multipart body',
  } satisfies FileUploadFailure;
  const noFile = {
    ok: false,
    resultType: 'file_upload',
    errorCode: 'no_file_provided',
  } satisfies FileUploadFailure;
  if (!request.body) return Promise.resolve(noFile);

  let parser: BusboyInstance;
  try {
    parser = Busboy({
      headers: { 'content-type': contentType },
      // Other parts are skipped, not stored: a few small fields and file
      // parts at most, so an upload is the file plus a small envelope.
      limits: { fileSize: options.maxSize, files: 10, fields: 10, fieldSize: 64 * 1024, parts: 30 },
    });
  } catch {
    return Promise.resolve(invalidBody); // no boundary, or not a multipart type busboy knows
  }
  const fieldName = options.fieldName ?? 'file';
  const source = Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>);

  return new Promise((resolve, reject) => {
    let file: BusboyFileStream | null = null;
    let stored: Promise<SinkResult> | null = null;
    let sinkSucceeded: SinkResult | null = null;
    let parsed = false;
    let uploadFailure: FileUploadFailure | null = null;
    let settled = false;

    const settle = (result: SinkResult | FileUploadFailure) => {
      if (settled) return;
      settled = true;
      if (!result.ok) {
        // A sink still reading sees an error, never a clean end.
        if (file && !file.readableEnded) file.destroy(new Error('upload failed'));
        source.unpipe(parser);
        source.resume(); // discard the rest (see above)
      }
      resolve(result);
    };
    /** The upload itself failed. With a sink running, answer once it has
     *  wound down (it aborts its write) — unless it already finished with
     *  the whole file, which then stands. */
    const fail = (failure: FileUploadFailure) => {
      uploadFailure ??= failure;
      if (file && !file.readableEnded) file.destroy(new Error(failure.errorCode));
      if (!stored) settle(uploadFailure);
      else if (sinkSucceeded) settle(sinkSucceeded);
    };

    parser.on('file', (field, stream, filename, _encoding, mimeType) => {
      // Every part stream gets an error listener: busboy errors the current
      // part on a malformed body, and settle() destroys the file with one —
      // unheard (a drained part, a sink that gave up before reading) that
      // is an uncaught exception, i.e. the process. The outcome travels in
      // the result instead.
      stream.on('error', () => {});
      // Not the file part: another field, a second file, or an empty
      // file input (filename ""). Drained, so parsing continues.
      if (settled || stored || field !== fieldName || filename === '') {
        stream.resume();
        return;
      }
      if (!options.allowedMimeTypes.includes(mimeType)) {
        stream.resume();
        settle(unsupportedFileType(options.allowedMimeTypes));
        return;
      }
      file = stream;
      // busboy truncates at fileSize and then ENDS the stream normally:
      // destroying it here is what keeps the sink from storing the cut-off file.
      stream.once('limit', () => fail(fileTooLarge(options.maxSize)));
      stored = sink({ name: filename, contentType: mimeType, stream });
      stored.then(result => {
        if (uploadFailure) settle(uploadFailure);
        else if (!result.ok)
          settle(result); // the sink gave up first (e.g. storage down)
        else if (parsed) settle(result);
        else sinkSucceeded = result; // wait for the parser to finish the body
      }, reject); // a sink that throws is a bug: surface it (a 500), don't hang the request
    });
    parser.on('finish', () => {
      parsed = true;
      if (!stored) settle(noFile);
      else if (sinkSucceeded) settle(sinkSucceeded);
    });
    parser.on('error', () => fail(invalidBody));
    // The body itself failed: client gone, or past the adapter's bodySizeLimit.
    source.on('error', () => fail(invalidBody));
    source.pipe(parser);
  });
}

/** A download's Range header (+ If-Range) as storage takes it, or null for
 *  the whole file. One byte range only: multiple ranges, other units and
 *  malformed or backwards specs are ignored — RFC 9110 §14.2 lets a server
 *  serve the full representation instead. Whether the range fits the file
 *  is storage's to say (a 416). */
export function parseRangeRequest(headers: Headers): ObjectRange | null {
  const raw = headers.get('range');
  if (raw === null) return null;
  // 15 digits: past any real size, inside a double's exact integers.
  const spec = /^bytes=(\d{1,15})?-(\d{1,15})?$/i.exec(raw.trim());
  if (!spec) return null;
  const [, first, last] = spec;
  if (first === undefined && last === undefined) return null; // "bytes=-"
  if (first !== undefined && last !== undefined && Number(first) > Number(last)) return null;
  return { bytes: `bytes=${first ?? ''}-${last ?? ''}`, ifRange: headers.get('if-range') };
}

/** A form post's failure as what a page renders: a form-level message
 *  and per-field issues. Exhaustive over the codes a form post can fail
 *  with — a new code is a type error here. */
export function parseAndValidateFailureToErrors<DataType extends object>(
  parseAndValidateFailure: ParseAndValidateFormPostFailure<DataType>,
) {
  const noIssues: Record<string, string> = {};

  switch (parseAndValidateFailure.errorCode) {
    case 'validation_failure':
      return { errorMessage: '', issues: parseAndValidateFailure.issues };
    case 'invalid_form_data':
      return {
        errorMessage:
          "Sorry, there was an error on our side. Please try again (error: 'invalid form data').",
        issues: noIssues,
      };
    case 'unsupported_content_type':
      return {
        errorMessage:
          "Sorry, there was an error on our side. Please try again (error: 'unsupported content type').",
        issues: noIssues,
      };
    default:
      return parseAndValidateFailure satisfies never;
  }
}
