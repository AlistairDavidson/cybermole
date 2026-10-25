// storage.test.mjs — src/lib/storage.ts against the in-memory fake S3
// (tests/fake-s3.mjs): one test per StoreUploadResult / FetchObjectResult
// error code, the bucket check/create on first use, streamed and
// multipart uploads (and the abort when a stream fails midway), and the
// responses objectStoreFailureResponse / fileDownloadResponse build. Plus
// the CYBERMOLE_S3_* boot checks in src/lib/env.ts, which read RAW_ENV at
// module load (child processes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import { Readable } from 'node:stream';
import { ObjectStore } from '../../dist-server/src/lib/storage.js';
import {
  fileDownloadResponse,
  fileHeadResponse,
  objectStoreFailureResponse,
} from '../../dist-server/src/lib/web/responses.service.js';
import { startFakeS3 } from '../fake-s3.mjs';

const ACCESS_KEY = 'unit-access';
const config = (endpoint, overrides = {}) => ({
  endpoint,
  region: 'us-east-1',
  bucket: 'unit-bucket',
  accessKeyId: ACCESS_KEY,
  secretAccessKey: 'unit-secret',
  ...overrides,
});
const upload = (name = 'notes.txt', body = new TextEncoder().encode('hello')) => ({
  name,
  contentType: 'text/plain',
  body,
});
const KEY_RE = /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MiB = 1024 * 1024;

/** A stream of `total` bytes of `fill`, in 64 KiB chunks; errors after `failAfter` bytes if set. */
function byteStream(total, { fill = 0x61, failAfter = Infinity } = {}) {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= failAfter) {
        this.destroy(new Error('client went away'));
        return;
      }
      if (sent >= total) {
        this.push(null);
        return;
      }
      const n = Math.min(64 * 1024, total - sent);
      sent += n;
      this.push(Buffer.alloc(n, fill));
    },
  });
}

async function fake(t) {
  const s3 = await startFakeS3({ accessKey: ACCESS_KEY });
  t.after(() => s3.close());
  return s3;
}

test('storage_not_configured without a config: upload, download and HEAD (503)', async () => {
  const store = new ObjectStore(null);
  const stored = await store.storeUpload(upload());
  assert.equal(stored.errorCode, 'storage_not_configured');
  const fetched = await store.fetchObject('uploads/00000000-0000-4000-8000-000000000000');
  assert.equal(fetched.errorCode, 'storage_not_configured');
  const stat = await store.statObject('uploads/00000000-0000-4000-8000-000000000000');
  assert.equal(stat.errorCode, 'storage_not_configured');
  for (const f of [stored, fetched, stat]) {
    const res = objectStoreFailureResponse(f);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'storage_not_configured');
  }
});

test('first upload creates the bucket, then stores under uploads/<uuid> with type and a safe disposition', async t => {
  const s3 = await fake(t);
  const store = new ObjectStore(config(s3.url));

  const r = await store.storeUpload(
    upload("q1 report (draft)'s – é.txt", new TextEncoder().encode('first')),
  );
  assert.equal(r.ok, true, r.errorMessage);
  assert.match(r.data.key, KEY_RE);
  assert.deepEqual(
    { ...r.data, key: undefined },
    { key: undefined, name: "q1 report (draft)'s – é.txt", size: 5, contentType: 'text/plain' },
  );
  const stored = s3.buckets.get('unit-bucket')?.get(r.data.key);
  assert.ok(stored, 'object is in the bucket');
  assert.equal(stored.body.toString(), 'first');
  assert.equal(stored.contentType, 'text/plain');
  // RFC 5987: ' ( ) * are percent-encoded too, so the header stays one token.
  assert.equal(
    stored.contentDisposition,
    "attachment; filename*=UTF-8''q1%20report%20%28draft%29%27s%20%E2%80%93%20%C3%A9.txt",
  );

  const second = await store.storeUpload(upload('b.txt'));
  assert.equal(second.ok, true, second.errorMessage);
  assert.notEqual(second.data.key, r.data.key);
  assert.equal(s3.buckets.get('unit-bucket')?.size, 2);
  assert.equal(s3.stats.creates, 1, 'the bucket is checked once, not per upload');
});

test('a stream is counted on the way through: one PUT when it fits a part', async t => {
  const s3 = await fake(t);
  const r = await new ObjectStore(config(s3.url)).storeUpload(upload('s.txt', byteStream(300_000)));
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.size, 300_000);
  assert.equal(s3.buckets.get('unit-bucket')?.get(r.data.key)?.body.length, 300_000);
  assert.equal(s3.stats.completed, 0, 'no multipart upload for one part');
});

test('a stream past one part goes up as a multipart upload, bytes and headers intact', async t => {
  const s3 = await fake(t);
  const total = 12 * MiB + 123;
  const r = await new ObjectStore(config(s3.url)).storeUpload(
    upload('big.txt', byteStream(total, { fill: 0x62 })),
  );
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.size, total);
  const stored = s3.buckets.get('unit-bucket')?.get(r.data.key);
  assert.equal(stored?.body.length, total);
  assert.ok(stored?.body.every(b => b === 0x62));
  assert.equal(stored?.contentDisposition, "attachment; filename*=UTF-8''big.txt");
  assert.equal(s3.stats.completed, 1);
  assert.equal(s3.multipart.size, 0);
});

test('storage_error: a stream that fails midway stores nothing and aborts the multipart upload', async t => {
  const s3 = await fake(t);
  const r = await new ObjectStore(config(s3.url)).storeUpload(
    upload('cut.txt', byteStream(20 * MiB, { failAfter: 11 * MiB })),
  );
  assert.equal(r.errorCode, 'storage_error');
  assert.match(r.errorMessage, /client went away/);
  assert.equal(s3.buckets.get('unit-bucket')?.size, 0);
  assert.equal(s3.stats.aborted, 1);
  assert.equal(s3.multipart.size, 0, 'no orphan parts left on the server');
});

test('credentials without ListBucket (HeadBucket 403) still write', async t => {
  const s3 = await fake(t);
  s3.buckets.set('unit-bucket', new Map());
  s3.faults.headStatus = 403;
  const r = await new ObjectStore(config(s3.url)).storeUpload(upload());
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(s3.stats.creates, 0);
});

test('a lost CreateBucket race (BucketAlreadyOwnedByYou) still stores the file', async t => {
  const s3 = await fake(t);
  s3.faults.createAnswersOwned = true;
  const r = await new ObjectStore(config(s3.url)).storeUpload(upload());
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(s3.buckets.get('unit-bucket')?.size, 1);
});

test('storage_error: CreateBucket refused (502)', async t => {
  const s3 = await fake(t);
  s3.faults.denyCreate = true;
  const r = await new ObjectStore(config(s3.url)).storeUpload(upload());
  assert.equal(r.errorCode, 'storage_error');
  assert.match(r.errorMessage, /could not create bucket unit-bucket: AccessDenied/);
  const res = objectStoreFailureResponse(r);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), {
    error: 'could not store the file',
    detail: r.errorMessage,
    code: 'storage_error',
  });
});

test("storage_error: the server keeps failing the put (after the SDK's retries)", async t => {
  const s3 = await fake(t);
  s3.buckets.set('unit-bucket', new Map());
  s3.faults.failPuts = 10;
  const r = await new ObjectStore(config(s3.url)).storeUpload(upload());
  assert.equal(r.errorCode, 'storage_error');
  assert.match(r.errorMessage, /InternalError/);
  assert.equal(s3.buckets.get('unit-bucket')?.size, 0);
});

test("storage_error: wrong credentials (the bucket check's 403 reads as scoped keys; the write says no)", async t => {
  const s3 = await fake(t);
  const r = await new ObjectStore(config(s3.url, { accessKeyId: 'someone-else' })).storeUpload(
    upload(),
  );
  assert.equal(r.errorCode, 'storage_error');
  assert.match(r.errorMessage, /could not store uploads\/.*: InvalidAccessKeyId/);
});

test('storage_error: nothing listening at the endpoint', async () => {
  // A port that was free a moment ago.
  const port = await new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const r = await new ObjectStore(config(`http://127.0.0.1:${port}`)).storeUpload(upload());
  assert.equal(r.errorCode, 'storage_error');
  assert.match(r.errorMessage, /ECONNREFUSED/);
});

// ---------- downloads ----------

test('fetchObject streams a stored file back with its metadata', async t => {
  const s3 = await fake(t);
  const store = new ObjectStore(config(s3.url));
  const stored = await store.storeUpload(upload('é.txt', new TextEncoder().encode('round trip')));
  assert.equal(stored.ok, true, stored.errorMessage);

  const r = await store.fetchObject(stored.data.key);
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(r.data.contentType, 'text/plain');
  assert.equal(r.data.contentLength, 10);
  assert.equal(r.data.contentDisposition, "attachment; filename*=UTF-8''%C3%A9.txt");
  assert.equal(r.data.etag, '"fake"');
  assert.ok(r.data.lastModified instanceof Date);
  assert.equal(r.data.contentRange, null);
  assert.equal(await new Response(r.data.body).text(), 'round trip');
});

/** A store holding one object with body '0123456789', and its key. */
async function digits(t) {
  const s3 = await fake(t);
  const store = new ObjectStore(config(s3.url));
  const stored = await store.storeUpload(upload('d.txt', new TextEncoder().encode('0123456789')));
  assert.equal(stored.ok, true, stored.errorMessage);
  return { s3, store, key: stored.data.key };
}

test('fetchObject with a range: the part, its length and Content-Range — first-last, open-ended, suffix', async t => {
  const { store, key } = await digits(t);
  const part = async bytes => {
    const r = await store.fetchObject(key, { bytes, ifRange: null });
    assert.equal(r.ok, true, r.errorMessage);
    return {
      text: await new Response(r.data.body).text(),
      length: r.data.contentLength,
      range: r.data.contentRange,
    };
  };
  assert.deepEqual(await part('bytes=2-4'), { text: '234', length: 3, range: 'bytes 2-4/10' });
  assert.deepEqual(await part('bytes=7-'), { text: '789', length: 3, range: 'bytes 7-9/10' });
  assert.deepEqual(await part('bytes=-2'), { text: '89', length: 2, range: 'bytes 8-9/10' });
  assert.deepEqual(
    await part('bytes=8-99'),
    { text: '89', length: 2, range: 'bytes 8-9/10' },
    'last past the end is clipped',
  );
});

test('range_not_satisfiable: a range starting past the end (416, Content-Range: bytes */size)', async t => {
  const { store, key } = await digits(t);
  const r = await store.fetchObject(key, { bytes: 'bytes=10-', ifRange: null });
  assert.equal(r.errorCode, 'range_not_satisfiable');
  assert.deepEqual(r.data, { objectSize: 10 });
  const res = objectStoreFailureResponse(r);
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */10');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal((await res.json()).code, 'range_not_satisfiable');
  // Size unknown: no Content-Range rather than a wrong one.
  const unknown = objectStoreFailureResponse({ ...r, data: { objectSize: null } });
  assert.equal(unknown.status, 416);
  assert.equal(unknown.headers.get('content-range'), null);
});

test('If-Range: the range applies only while the validator matches (strong ETag or exact Last-Modified)', async t => {
  const { s3, store, key } = await digits(t);
  const fetchWith = async ifRange => {
    const r = await store.fetchObject(key, { bytes: 'bytes=5-', ifRange });
    assert.equal(r.ok, true, r.errorMessage);
    return { range: r.data.contentRange, text: await new Response(r.data.body).text() };
  };
  const lastModified = s3.buckets.get('unit-bucket').get(key).lastModified.toUTCString();
  assert.deepEqual(await fetchWith('"fake"'), { range: 'bytes 5-9/10', text: '56789' });
  assert.deepEqual(await fetchWith(lastModified), { range: 'bytes 5-9/10', text: '56789' });
  // Changed (or unknowable): the whole file, 200 — never a part of a different version.
  for (const stale of ['"other"', 'W/"fake"', 'Thu, 01 Jan 1970 00:00:00 GMT', 'garbage']) {
    assert.deepEqual(await fetchWith(stale), { range: null, text: '0123456789' }, stale);
  }
  // Without If-Range, no HEAD round trip.
  const heads = s3.stats.heads;
  await store.fetchObject(key, { bytes: 'bytes=0-0', ifRange: null });
  assert.equal(s3.stats.heads, heads);
});

test('If-Range on a missing file is still object_not_found', async t => {
  const { store } = await digits(t);
  const r = await store.fetchObject('uploads/00000000-0000-4000-8000-000000000000', {
    bytes: 'bytes=0-',
    ifRange: '"fake"',
  });
  assert.equal(r.errorCode, 'object_not_found');
});

test('statObject: metadata without a body; object_not_found; storage_error', async t => {
  const { s3, store, key } = await digits(t);
  const r = await store.statObject(key);
  assert.equal(r.ok, true, r.errorMessage);
  assert.deepEqual(
    { ...r.data, lastModified: r.data.lastModified instanceof Date },
    {
      contentType: 'text/plain',
      contentLength: 10,
      contentDisposition: "attachment; filename*=UTF-8''d.txt",
      etag: '"fake"',
      lastModified: true,
    },
  );
  const missing = await store.statObject('uploads/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.errorCode, 'object_not_found');
  assert.equal(objectStoreFailureResponse(missing).status, 404);
  s3.faults.failGets = true;
  const broken = await store.statObject(key);
  assert.equal(broken.errorCode, 'storage_error');
  assert.equal(objectStoreFailureResponse(broken).status, 502);
});

test('object_not_found: an unknown key, or no bucket yet (404)', async t => {
  const s3 = await fake(t);
  const store = new ObjectStore(config(s3.url));
  const key = 'uploads/00000000-0000-4000-8000-000000000000';
  const noBucket = await store.fetchObject(key);
  assert.equal(noBucket.errorCode, 'object_not_found');
  s3.buckets.set('unit-bucket', new Map());
  const noKey = await store.fetchObject(key);
  assert.equal(noKey.errorCode, 'object_not_found');
  const res = objectStoreFailureResponse(noKey);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'no such file', code: 'object_not_found' });
});

test('storage_error: the server fails the read (502)', async t => {
  const s3 = await fake(t);
  s3.buckets.set('unit-bucket', new Map());
  s3.faults.failGets = true;
  const r = await new ObjectStore(config(s3.url)).fetchObject(
    'uploads/00000000-0000-4000-8000-000000000000',
  );
  assert.equal(r.errorCode, 'storage_error');
  const res = objectStoreFailureResponse(r);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'could not read the file');
});

test('fileDownloadResponse: always an attachment, sandboxed, allowlisted type or octet-stream', async () => {
  const object = over => ({
    body: new Response('x').body,
    contentType: 'text/plain',
    contentLength: 1,
    contentRange: null,
    contentDisposition: "attachment; filename*=UTF-8''a.txt",
    etag: '"e"',
    lastModified: new Date(0),
    ...over,
  });
  const ok = fileDownloadResponse(object({}));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('accept-ranges'), 'bytes');
  assert.equal(ok.headers.get('content-range'), null);
  assert.equal(ok.headers.get('content-type'), 'text/plain');
  assert.equal(ok.headers.get('content-disposition'), "attachment; filename*=UTF-8''a.txt");
  assert.equal(ok.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  assert.equal(ok.headers.get('content-length'), '1');
  assert.equal(ok.headers.get('etag'), '"e"');
  assert.equal(ok.headers.get('last-modified'), new Date(0).toUTCString());
  assert.equal(await ok.text(), 'x');

  // Written to the bucket some other way: an HTML type, inline disposition, no metadata.
  const odd = fileDownloadResponse(
    object({
      contentType: 'text/html',
      contentDisposition: 'inline',
      contentLength: null,
      etag: null,
      lastModified: null,
    }),
  );
  assert.equal(odd.headers.get('content-type'), 'application/octet-stream');
  assert.equal(odd.headers.get('content-disposition'), 'attachment');
  assert.equal(odd.headers.get('content-length'), null);
  assert.equal(
    fileDownloadResponse(object({ contentType: null })).headers.get('content-type'),
    'application/octet-stream',
  );

  // A part: 206 with S3's Content-Range and the part's length.
  const part = fileDownloadResponse(object({ contentLength: 3, contentRange: 'bytes 2-4/10' }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(part.headers.get('content-length'), '3');

  // HEAD: the same headers, the whole size, no body.
  const { body: _body, contentRange: _range, ...info } = object({ contentLength: 10 });
  const head = fileHeadResponse(info);
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('content-disposition'), "attachment; filename*=UTF-8''a.txt");
});

// ---------- CYBERMOLE_S3_* boot checks (src/lib/env.ts) ----------

/** readObjectStoreConfig() in a fresh process (RAW_ENV is read at module load), or its error. */
function bootConfig(env) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('CYBERMOLE_S3_')),
  );
  try {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/env.js').readObjectStoreConfig()))",
      ],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { config: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('env: no CYBERMOLE_S3_* (or only empty ones) is "not configured"', () => {
  assert.deepEqual(bootConfig({}), { config: null });
  assert.deepEqual(bootConfig({ CYBERMOLE_S3_ENDPOINT: '', CYBERMOLE_S3_ACCESS_KEY: '' }), {
    config: null,
  });
});

test('env: endpoint + both keys configure the store, with bucket/region defaults', () => {
  assert.deepEqual(
    bootConfig({
      CYBERMOLE_S3_ENDPOINT: 'http://seaweedfs:8333',
      CYBERMOLE_S3_ACCESS_KEY: 'a',
      CYBERMOLE_S3_SECRET_KEY: 's',
    }),
    {
      config: {
        endpoint: 'http://seaweedfs:8333',
        accessKeyId: 'a',
        secretAccessKey: 's',
        bucket: 'cybermole',
        region: 'us-east-1',
      },
    },
  );
});

test('env: a half-configured, non-http or misnamed store stops the boot', () => {
  const keys = { CYBERMOLE_S3_ACCESS_KEY: 'a', CYBERMOLE_S3_SECRET_KEY: 's' };
  assert.match(
    bootConfig({ CYBERMOLE_S3_ENDPOINT: 'http://seaweedfs:8333', CYBERMOLE_S3_ACCESS_KEY: 'a' })
      .error,
    /must be set together/,
  );
  assert.match(bootConfig(keys).error, /must be set together/);
  assert.match(
    bootConfig({ ...keys, CYBERMOLE_S3_ENDPOINT: 'seaweedfs:8333' }).error,
    /is not an http\(s\) URL/,
  );
  assert.match(
    bootConfig({ ...keys, CYBERMOLE_S3_ENDPOINT: 'ftp://seaweedfs' }).error,
    /is not an http\(s\) URL/,
  );
  assert.match(
    bootConfig({
      ...keys,
      CYBERMOLE_S3_ENDPOINT: 'http://seaweedfs:8333',
      CYBERMOLE_S3_BUCKET: 'Cybermole',
    }).error,
    /is not a valid bucket name/,
  );
});
