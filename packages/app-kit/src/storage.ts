// Object storage: one bucket on any S3-compatible server, via the AWS SDK.
// Every SDK call is caught and becomes a failure result. Uploads stream
// (one PUT, or multipart aborted on failure), so memory stays at a few parts
// whatever the size. The bucket is created on first upload if missing.
// Logging goes through setStorageLogger(); by default lines are dropped.
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
import { asObjectKey, type ObjectKey } from './types/branded';
import type { ResultFailure, ResultSuccess } from './types/result';

export interface StorageLogger {
  info(message: string): void;
  warn(message: string): void;
}

const silent: StorageLogger = {
  info: () => undefined,
  warn: () => undefined,
};
let storageLog: StorageLogger = silent;

/** Call once at startup, before the first ObjectStore is built. */
export function setStorageLogger(log: StorageLogger): void {
  storageLog = log;
}

/** The CYBERMOLE_S3_* variables. */
export interface ObjectStoreConfig {
  /** http(s) URL of the S3 API, e.g. http://seaweedfs:8333 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface UploadInput {
  /** kept for Content-Disposition, never part of the key */
  name: string;
  contentType: string;
  /** a stream is stored only if it ends cleanly */
  body: Readable | Uint8Array;
}

export type StoreUploadData = { key: ObjectKey; name: string; size: number; contentType: string };
/** storage_error includes a body that failed mid-stream (nothing is stored then). */
export type StoreUploadErrorCode = 'storage_not_configured' | 'storage_error';
export type StoreUploadSuccess = ResultSuccess<'store_upload', StoreUploadData>;
export type StoreUploadFailure = ResultFailure<
  'store_upload',
  StoreUploadData,
  StoreUploadErrorCode
>;
export type StoreUploadResult = StoreUploadSuccess | StoreUploadFailure;

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

/** One validated byte range ("bytes=0-99", "bytes=100-", "bytes=-500"),
 *  plus an optional If-Range validator. S3 has no If-Range, so
 *  fetchObject checks it itself. */
export interface ObjectRange {
  bytes: string;
  ifRange: string | null;
}

/** The body streams from S3. */
export interface FetchedObject extends ObjectInfo {
  body: ReadableStream<Uint8Array>;
  /** S3's Content-Range for a partial read, else null; contentLength is then the part's. */
  contentRange: string | null;
}
/** range_not_satisfiable: starts past the end; objectSize when readable. */
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

const NOT_CONFIGURED = 'object storage is not configured (CYBERMOLE_S3_ENDPOINT)';

/** encodeURIComponent leaves ' ( ) * alone, which RFC 5987 doesn't allow. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code; // network errors carry no S3 name
  return [err.name, code, err.message].filter(Boolean).join(': ');
}

function isS3Error(err: unknown, code: string): boolean {
  return err instanceof S3ServiceException && err.name === code;
}

function httpStatus(err: unknown): number | undefined {
  return err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
}

/** RFC 9110 §13.1.5: a strong ETag or a Last-Modified date (to the second)
 *  must match; weak tags never do. */
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
        // Self-hosted servers have no per-bucket DNS.
        forcePathStyle: true,
        // The default adds CRC32 trailers to every put, which several
        // S3-compatible servers reject.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        // The default is no timeout. requestTimeout is per-socket inactivity,
        // so a long flowing download is fine.
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 120_000 },
      });
  }

  describe(): string | null {
    return this.config && `${this.config.endpoint} bucket ${this.config.bucket}`;
  }

  /** A 403 on HeadBucket means credentials scoped to an existing bucket;
   *  carry on and let the write say. */
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
        // Another request created it first.
        if (!isS3Error(createErr, 'BucketAlreadyOwnedByYou')) {
          return fail(`could not create bucket ${bucket}: ${describe(createErr)}`);
        }
      }
    }
    this.bucketReady = true;
    return ok;
  }

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

    // A stream's size is only known once read: count it on the way through.
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
              /* errors reach the Upload via the destroyed Transform */
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
          // Saved as a file, never rendered inline on our origin.
          ContentDisposition: `attachment; filename*=UTF-8''${rfc5987(upload.name)}`,
        },
        // ~65 MiB of buffers at peak whatever the file size; 10,000 parts
        // max means objects up to ~48 GiB.
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
      }).done();
    } catch (err) {
      if (isS3Error(err, 'NoSuchBucket')) this.bucketReady = false; // deleted under us
      storageLog.warn(
        `upload of ${key} (${upload.name}, ${size} bytes read) failed: ${describe(err)}`,
      );
      return fail('storage_error', `could not store ${key}: ${describe(err)}`);
    }

    storageLog.info(`stored upload ${key} (${upload.name}, ${size} bytes)`);
    return {
      ok: true,
      resultType: 'store_upload',
      data: { key, name: upload.name, size, contentType: upload.contentType },
    } satisfies StoreUploadSuccess;
  }

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
      // A HEAD has no error body: a missing key or bucket is just a 404.
      if (httpStatus(err) === 404) return fail('object_not_found', `no object ${key}`);
      storageLog.warn(`stat of ${key} failed: ${describe(err)}`);
      return fail('storage_error', `could not read ${key}: ${describe(err)}`);
    }
  }

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

    // If-Range needs the current validators: one HEAD, only on resumes.
    let bytes = range?.bytes ?? null;
    if (range?.ifRange) {
      const info = await this.statObject(key);
      if (!info.ok) return fail(info.errorCode, info.errorMessage ?? `could not read ${key}`);
      if (!ifRangeMatches(range.ifRange, info.data)) bytes = null; // changed: send it all
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
      // No bucket means nothing was ever uploaded.
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
      storageLog.warn(`download of ${key} failed: ${describe(err)}`);
      return fail('storage_error', `could not read ${key}: ${describe(err)}`);
    }
  }
}
