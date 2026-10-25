// Request parsing and zod validation as Results. Imports `zod`, not
// `astro/zod`: the plain-tsc server build compiles this too.
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Busboy, type BusboyFileStream, type BusboyInstance } from '@fastify/busboy';
import type { z, ZodType } from 'zod';
import type { ObjectRange } from '../platform/storage';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

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

/** First issue per field, keyed by dotted path ("" for the root). */
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

/** Buffers the whole body; large files go through streamFileUpload. */
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

/** Streamed to a sink as it arrives, so memory stays flat. */
export interface FileUploadStream {
  /** an empty name means no file */
  name: string;
  /** already checked against allowedMimeTypes */
  contentType: string;
  /** Ends cleanly only if the whole file arrived within maxSize; otherwise
   *  it's destroyed with an error, so a sink never stores a truncated file. */
  stream: Readable;
}

/** Must settle once the stream ends or errors, and catch its own failures. */
export type FileUploadSink<SinkResult extends { ok: boolean }> = (
  file: FileUploadStream,
) => Promise<SinkResult>;

/** Streams the first `fieldName` part into `sink`, checking the type before
 *  any bytes and the size as they arrive. An upload failure wins over the
 *  sink failure it caused (oversized → file_too_large).
 *
 *  On failure the rest of the body is drained, not torn down: a reset
 *  connection would show the client a network error instead of the answer. */
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
      // Other parts are drained, not stored.
      limits: { fileSize: options.maxSize, files: 10, fields: 10, fieldSize: 64 * 1024, parts: 30 },
    });
  } catch {
    return Promise.resolve(invalidBody); // no boundary, or an unknown multipart type
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
        source.resume(); // drain the rest
      }
      resolve(result);
    };
    /** With a sink running, answer once it winds down, unless it already
     *  stored the whole file. */
    const fail = (failure: FileUploadFailure) => {
      uploadFailure ??= failure;
      if (file && !file.readableEnded) file.destroy(new Error(failure.errorCode));
      if (!stored) settle(uploadFailure);
      else if (sinkSucceeded) settle(sinkSucceeded);
    };

    parser.on('file', (field, stream, filename, _encoding, mimeType) => {
      // settle() destroys the part with an error; unheard, that would be an
      // uncaught exception. The outcome travels in the result instead.
      stream.on('error', () => {});
      // Another field, a second file, or an empty file input: drain it.
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
      // busboy truncates at fileSize and ends normally; destroying the
      // stream keeps the sink from storing the cut-off file.
      stream.once('limit', () => fail(fileTooLarge(options.maxSize)));
      stored = sink({ name: filename, contentType: mimeType, stream });
      stored.then(result => {
        if (uploadFailure) settle(uploadFailure);
        else if (!result.ok)
          settle(result); // e.g. storage down
        else if (parsed) settle(result);
        else sinkSucceeded = result; // wait for the parser to finish
      }, reject); // a throwing sink is a bug: surface it as a 500
    });
    parser.on('finish', () => {
      parsed = true;
      if (!stored) settle(noFile);
      else if (sinkSucceeded) settle(sinkSucceeded);
    });
    parser.on('error', () => fail(invalidBody));
    // Client gone, or past the adapter's bodySizeLimit.
    source.on('error', () => fail(invalidBody));
    source.pipe(parser);
  });
}

/** One byte range only; anything else is ignored and the full file served
 *  (RFC 9110 §14.2 allows it). Storage decides whether it fits (416). */
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

/** Exhaustive over the form-post failure codes. */
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
