// storage.ts — object storage: one bucket on any S3-compatible server,
// through the AWS SDK. The compose stack runs SeaweedFS (compose.yaml);
// nothing here is SeaweedFS-specific, so S3/R2/Garage/… work unchanged.
//
// The boundary for S3 (docs/CODE_STYLE.md §2): every SDK call is caught
// here and becomes a failure result. The client connects lazily (the SDK
// opens nothing until the first request) and the bucket is created on
// first use: a put into a missing bucket creates it and retries once — so
// a fresh server, or a bucket deleted under us, needs no setup step, and
// credentials scoped to an existing bucket never need CreateBucket.
//
// Built once by server/main.ts and reached through locals.webpi
// (src/lib/services.ts) — Astro code never imports this module at runtime.
import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { asObjectKey, type ObjectKey } from '../types/branded';
import type { ResultFailure, ResultSuccess } from '../types/result';

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
  body: Uint8Array;
}

export type StoreUploadData = { key: ObjectKey; name: string; size: number; contentType: string };
/** storage_not_configured: no WEB_PI_S3_ENDPOINT. storage_error: the S3
 *  server refused or failed the write, or could not be reached. */
export type StoreUploadErrorCode = 'storage_not_configured' | 'storage_error';
export type StoreUploadSuccess = ResultSuccess<'store_upload', StoreUploadData>;
export type StoreUploadFailure = ResultFailure<'store_upload', StoreUploadData, StoreUploadErrorCode>;
export type StoreUploadResult = StoreUploadSuccess | StoreUploadFailure;

/** RFC 5987 ext-value: percent-encode everything outside attr-char
 *  (encodeURIComponent leaves ' ( ) * alone). */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
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

export class ObjectStore {
  private readonly client: S3Client | null;

  constructor(private readonly config: ObjectStoreConfig | null) {
    this.client = config && new S3Client({
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
      // The SDK's default is no timeout: a hung server would hold the
      // upload request open forever.
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    });
  }

  /** endpoint + bucket for the boot log, or null when not configured. */
  describe(): string | null {
    return this.config && `${this.config.endpoint} bucket ${this.config.bucket}`;
  }

  /** Store one uploaded file under a fresh key (uploads/<uuid>). */
  async storeUpload(upload: UploadInput) {
    const fail = (errorCode: StoreUploadErrorCode, errorMessage: string) =>
      ({ ok: false, resultType: 'store_upload', errorCode, errorMessage }) satisfies StoreUploadFailure;
    if (!this.client || !this.config) {
      return fail('storage_not_configured', 'object storage is not configured (WEB_PI_S3_ENDPOINT)');
    }
    const { client, config } = this;

    const key = asObjectKey(`uploads/${randomUUID()}`);
    const put = () => client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: upload.body,
      ContentLength: upload.body.byteLength,
      ContentType: upload.contentType,
      // attachment: a future download route serves it as a file, never
      // rendered inline on the app's origin.
      ContentDisposition: `attachment; filename*=UTF-8''${rfc5987(upload.name)}`,
    }));

    try {
      await put();
    } catch (err) {
      if (!isS3Error(err, 'NoSuchBucket')) return fail('storage_error', `could not store ${key}: ${describe(err)}`);
      try {
        await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
      } catch (createErr) {
        // Another request created it first — that's the goal either way.
        if (!isS3Error(createErr, 'BucketAlreadyOwnedByYou')) {
          return fail('storage_error', `could not create bucket ${config.bucket}: ${describe(createErr)}`);
        }
      }
      try {
        await put();
      } catch (retryErr) {
        return fail('storage_error', `could not store ${key}: ${describe(retryErr)}`);
      }
    }

    return {
      ok: true, resultType: 'store_upload',
      data: { key, name: upload.name, size: upload.body.byteLength, contentType: upload.contentType },
    } satisfies StoreUploadSuccess;
  }
}
