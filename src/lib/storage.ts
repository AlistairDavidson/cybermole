// storage.ts — object storage: one bucket on any S3-compatible server,
// through the AWS SDK. The compose stack runs SeaweedFS (compose.yaml);
// nothing here is SeaweedFS-specific, so S3/R2/Garage/… work unchanged.
//
// The boundary for S3 (docs/CODE_STYLE.md §2): every SDK call is caught
// here and becomes a failure result. Uploads stream: a body is sent as it
// is read (lib-storage — one PUT if it fits a part, a multipart upload
// otherwise, aborted if the body fails midway), so memory stays at a few
// parts whatever the size. The client connects lazily (the SDK opens
// nothing until the first request), and the bucket is checked — created
// if missing — before the first upload, so a fresh server needs no setup
// step.
//
// Built once by server/main.ts and reached through locals.webpi
// (src/lib/services.ts) — Astro code never imports this module at runtime.
import { randomUUID } from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { componentLogger } from './logger';
import { asObjectKey, type ObjectKey } from '../types/branded';
import type { ResultFailure, ResultSuccess } from '../types/result';

const log = componentLogger('storage');

/** readObjectStoreConfig() (src/lib/env.ts) — the WEB_PI_S3_* variables. */
export interface ObjectStoreConfig {
  /** http(s) URL of the S3 API, e.g. http://seaweedfs:8333 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface UploadInput {
  /** the client's file name — kept for downloads (Content-Disposition), never part of the key */
  name: string;
  contentType: string;
  /** a stream is stored only if it ends cleanly; an error aborts the write */
  body: Readable | Uint8Array;
}

export type StoreUploadData = { key: ObjectKey; name: string; size: number; contentType: string };
/** storage_not_configured: no WEB_PI_S3_ENDPOINT. storage_error: the S3
 *  server refused or failed the write, could not be reached, or the body
 *  failed while streaming (nothing is stored then). */
export type StoreUploadErrorCode = 'storage_not_configured' | 'storage_error';
export type StoreUploadSuccess = ResultSuccess<'store_upload', StoreUploadData>;
export type StoreUploadFailure = ResultFailure<
  'store_upload',
  StoreUploadData,
  StoreUploadErrorCode
>;
export type StoreUploadResult = StoreUploadSuccess | StoreUploadFailure;

/** A stored object's metadata (HeadObject). */
export interface ObjectInfo {
  contentType: string | null;
  /** the whole object's size */
  contentLength: number | null;
  contentDisposition: string | null;
  etag: string | null;
  lastModified: Date | null;
}
export type StatObjectErrorCode = 'storage_not_configured' | 'object_not_found' | 'storage_error';
export type StatObjectSuccess = ResultSuccess<'stat_object', ObjectInfo>;
export type StatObjectFailure = ResultFailure<'stat_object', ObjectInfo, StatObjectErrorCode>;
export type StatObjectResult = StatObjectSuccess | StatObjectFailure;

/** Part of an object to read: one byte range in HTTP's syntax, already
 *  validated ("bytes=0-99", "bytes=100-", "bytes=-500"), and optionally an
 *  If-Range validator — the range applies only while it still matches the
 *  object's ETag / Last-Modified, otherwise the whole object comes back.
 *  S3 has no If-Range, so fetchObject checks it. */
export interface ObjectRange {
  bytes: string;
  ifRange: string | null;
}

/** A stored object (or the requested part of it), its body still to be
 *  read — it streams from S3. */
export interface FetchedObject extends ObjectInfo {
  body: ReadableStream<Uint8Array>;
  /** S3's Content-Range ("bytes 0-99/1000") when this is a part, else null.
   *  contentLength is then the part's length. */
  contentRange: string | null;
}
/** range_not_satisfiable: the range starts past the end (or the object is
 *  empty); data.objectSize says how big it is, when that could be read. */
export type FetchObjectErrorCode =
  'storage_not_configured' | 'object_not_found' | 'range_not_satisfiable' | 'storage_error';
export type FetchObjectFailureData = { objectSize: number | null };
export type FetchObjectSuccess = ResultSuccess<'fetch_object', FetchedObject>;
export type FetchObjectFailure = ResultFailure<
  'fetch_object',
  FetchObjectFailureData,
  FetchObjectErrorCode
>;
export type FetchObjectResult = FetchObjectSuccess | FetchObjectFailure;

type EnsureBucketResult =
  | ResultSuccess<'ensure_bucket', { bucket: string }>
  | ResultFailure<'ensure_bucket', { bucket: string }, 'storage_error'>;

const NOT_CONFIGURED = 'object storage is not configured (WEB_PI_S3_ENDPOINT)';

/** RFC 5987 ext-value: percent-encode everything outside attr-char
 *  (encodeURIComponent leaves ' ( ) * alone). */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code; // ECONNREFUSED & co (network errors carry no S3 name)
  return [err.name, code, err.message].filter(Boolean).join(': ');
}

/** An S3 error response with this error code (an S3 code, not a message). */
function isS3Error(err: unknown, code: string): boolean {
  return err instanceof S3ServiceException && err.name === code;
}

function httpStatus(err: unknown): number | undefined {
  return err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
}

/** HTTP If-Range (RFC 9110 §13.1.5): a strong entity tag must equal the
 *  object's ETag; an HTTP-date must equal its Last-Modified (to the
 *  second). A weak tag, or anything unparseable, never matches. */
function ifRangeMatches(validator: string, info: ObjectInfo): boolean {
  const v = validator.trim();
  if (v.startsWith('W/')) return false;
  if (v.startsWith('"')) return info.etag !== null && v === info.etag;
  const date = Date.parse(v);
  return (
    !Number.isNaN(date) &&
    info.lastModified !== null &&
    Math.floor(info.lastModified.getTime() / 1000) === Math.floor(date / 1000)
  );
}

export class ObjectStore {
  private readonly client: S3Client | null;
  /** Set once the bucket is known to exist; reset when a write says it doesn't. */
  private bucketReady = false;

  constructor(private readonly config: ObjectStoreConfig | null) {
    this.client =
      config &&
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        // bucket in the path, not the hostname: self-hosted servers have no
        // per-bucket DNS.
        forcePathStyle: true,
        // Checksums only where S3 requires them. The SDK's default
        // (WHEN_SUPPORTED) adds CRC32 trailers to every put, which several
        // S3-compatible servers reject or don't return.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        // The SDK's default is no timeout: a hung server would hold a request
        // open forever. requestTimeout is per-socket inactivity, not a total —
        // a long download that keeps flowing is fine; 2 min leaves room for a
        // slow browser stalling the stream it reads from.
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 120_000 },
      });
  }

  /** endpoint + bucket for the boot log, or null when not configured. */
  describe(): string | null {
    return this.config && `${this.config.endpoint} bucket ${this.config.bucket}`;
  }

  /** HeadBucket, then CreateBucket if it's missing. A 403 on the head means
   *  credentials scoped to an existing bucket (no ListBucket) — carry on
   *  and let the write itself say. */
  private async ensureBucket(client: S3Client, bucket: string): Promise<EnsureBucketResult> {
    const ok = {
      ok: true,
      resultType: 'ensure_bucket',
      data: { bucket },
    } satisfies EnsureBucketResult;
    const fail = (errorMessage: string) =>
      ({
        ok: false,
        resultType: 'ensure_bucket',
        errorCode: 'storage_error',
        errorMessage,
      }) satisfies EnsureBucketResult;
    if (this.bucketReady) return ok;
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err) {
      if (httpStatus(err) === 403) return ok;
      if (httpStatus(err) !== 404)
        return fail(`could not check bucket ${bucket}: ${describe(err)}`);
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (createErr) {
        // Another request created it first — that's the goal either way.
        if (!isS3Error(createErr, 'BucketAlreadyOwnedByYou')) {
          return fail(`could not create bucket ${bucket}: ${describe(createErr)}`);
        }
      }
    }
    this.bucketReady = true;
    return ok;
  }

  /** Store one uploaded file under a fresh key (uploads/<uuid>). */
  async storeUpload(upload: UploadInput) {
    const fail = (errorCode: StoreUploadErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'store_upload',
        errorCode,
        errorMessage,
      }) satisfies StoreUploadFailure;
    if (!this.client || !this.config) return fail('storage_not_configured', NOT_CONFIGURED);
    const { client, config } = this;

    const bucket = await this.ensureBucket(client, config.bucket);
    if (!bucket.ok)
      return fail(
        'storage_error',
        bucket.errorMessage ?? `could not check bucket ${config.bucket}`,
      );

    // A stream's size is known only once it's read: count it on the way through.
    let size = upload.body instanceof Uint8Array ? upload.body.byteLength : 0;
    const body =
      upload.body instanceof Uint8Array
        ? upload.body
        : pipeline(
            upload.body,
            new Transform({
              transform(chunk: Buffer, _encoding, done) {
                size += chunk.length;
                done(null, chunk);
              },
            }),
            () => {
              /* errors reach the Upload through the destroyed Transform */
            },
          );

    const key = asObjectKey(`uploads/${randomUUID()}`);
    try {
      await new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: upload.contentType,
          // attachment: a download is saved as a file, never rendered inline
          // on the app's origin (the download route keeps it that way).
          ContentDisposition: `attachment; filename*=UTF-8''${rfc5987(upload.name)}`,
        },
        // Memory per upload: queueSize parts of partSize in flight (20 MiB of
        // parts; ~65 MiB of buffers at peak, measured — flat whatever the
        // file size). 10,000 parts max ⇒ objects up to ~48 GiB.
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false, // a failed multipart upload is aborted, not left as orphan parts
      }).done();
    } catch (err) {
      if (isS3Error(err, 'NoSuchBucket')) this.bucketReady = false; // deleted under us: re-check next time
      // task/winston-loki merge: upload failures logged — ${size} here is
      // the byte count so far (streams count on the way through).
      log.warn(`upload of ${key} (${upload.name}, ${size} bytes read) failed: ${describe(err)}`);
      return fail('storage_error', `could not store ${key}: ${describe(err)}`);
    }

    // task/winston-loki merge: ${size} (not upload.body.byteLength) — a
    // stream body has no byteLength; the Transform above counted it.
    log.info(`stored upload ${key} (${upload.name}, ${size} bytes)`);
    return {
      ok: true,
      resultType: 'store_upload',
      data: { key, name: upload.name, size, contentType: upload.contentType },
    } satisfies StoreUploadSuccess;
  }

  /** A stored object's metadata, without its body (HEAD of a download). */
  async statObject(key: ObjectKey) {
    const fail = (errorCode: StatObjectErrorCode, errorMessage: string) =>
      ({
        ok: false,
        resultType: 'stat_object',
        errorCode,
        errorMessage,
      }) satisfies StatObjectFailure;
    if (!this.client || !this.config) return fail('storage_not_configured', NOT_CONFIGURED);

    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        ok: true,
        resultType: 'stat_object',
        data: {
          contentType: head.ContentType ?? null,
          contentLength: head.ContentLength ?? null,
          contentDisposition: head.ContentDisposition ?? null,
          etag: head.ETag ?? null,
          lastModified: head.LastModified ?? null,
        },
      } satisfies StatObjectSuccess;
    } catch (err) {
      // A HEAD has no error body: a missing key (or bucket) is just a 404.
      if (httpStatus(err) === 404) return fail('object_not_found', `no object ${key}`);
      // task/winston-loki merge: failure-path coverage extended to the
      // download ops (success-side download logging left for review).
      log.warn(`stat of ${key} failed: ${describe(err)}`);
      return fail('storage_error', `could not read ${key}: ${describe(err)}`);
    }
  }

  /** Open a stored object — or one byte range of it — for download (its
   *  body streams from S3). */
  async fetchObject(key: ObjectKey, range: ObjectRange | null = null) {
    const fail = (
      errorCode: FetchObjectErrorCode,
      errorMessage: string,
      objectSize: number | null = null,
    ) =>
      ({
        ok: false,
        resultType: 'fetch_object',
        errorCode,
        errorMessage,
        data: { objectSize },
      }) satisfies FetchObjectFailure;
    if (!this.client || !this.config) return fail('storage_not_configured', NOT_CONFIGURED);
    const { client, config } = this;

    // If-Range needs the current validators before deciding what to read:
    // one HEAD, only on a conditional (resumed) download.
    let bytes = range?.bytes ?? null;
    if (range?.ifRange) {
      const info = await this.statObject(key);
      if (!info.ok) return fail(info.errorCode, info.errorMessage ?? `could not read ${key}`);
      if (!ifRangeMatches(range.ifRange, info.data)) bytes = null; // changed since: send it all
    }

    try {
      const object = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          ...(bytes === null ? {} : { Range: bytes }),
        }),
      );
      if (!object.Body) return fail('storage_error', `no body for ${key}`);
      return {
        ok: true,
        resultType: 'fetch_object',
        data: {
          body: object.Body.transformToWebStream() as ReadableStream<Uint8Array>,
          contentType: object.ContentType ?? null,
          contentLength: object.ContentLength ?? null,
          contentRange: object.ContentRange ?? null,
          contentDisposition: object.ContentDisposition ?? null,
          etag: object.ETag ?? null,
          lastModified: object.LastModified ?? null,
        },
      } satisfies FetchObjectSuccess;
    } catch (err) {
      // A missing bucket means nothing was ever uploaded: not found either.
      if (isS3Error(err, 'NoSuchKey') || isS3Error(err, 'NoSuchBucket'))
        return fail('object_not_found', `no object ${key}`);
      if (isS3Error(err, 'InvalidRange')) {
        // For the 416's Content-Range: bytes */<size>.
        const info = await this.statObject(key);
        return fail(
          'range_not_satisfiable',
          `${bytes} is outside ${key}`,
          info.ok ? info.data.contentLength : null,
        );
      }
      log.warn(`download of ${key} failed: ${describe(err)}`);
      return fail('storage_error', `could not read ${key}: ${describe(err)}`);
    }
  }
}
