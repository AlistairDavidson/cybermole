// storage.test.mjs — src/lib/storage.ts against the in-memory fake S3
// (tests/fake-s3.mjs): one test per StoreUploadResult error code, the
// create-the-bucket-on-first-use path, and the statuses
// storeUploadFailureResponse maps them to. Plus the WEB_PI_S3_* boot
// checks in src/lib/env.ts, which run at module load (child processes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import { ObjectStore } from '../../dist-server/src/lib/storage.js';
import { storeUploadFailureResponse } from '../../dist-server/src/lib/web/responses.service.js';
import { startFakeS3 } from '../fake-s3.mjs';

const ACCESS_KEY = 'unit-access';
const config = (endpoint, overrides = {}) => ({
  endpoint, region: 'us-east-1', bucket: 'unit-bucket', accessKeyId: ACCESS_KEY, secretAccessKey: 'unit-secret', ...overrides,
});
const upload = (name = 'notes.txt', text = 'hello') =>
  ({ name, contentType: 'text/plain', body: new TextEncoder().encode(text) });

test('storage_not_configured without a config (503)', async () => {
  const r = await new ObjectStore(null).storeUpload(upload());
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'storage_not_configured');
  const res = storeUploadFailureResponse(r);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'storage_not_configured');
});

test('first upload creates the bucket, then stores under uploads/<uuid> with type and a safe disposition', async t => {
  const fake = await startFakeS3({ accessKey: ACCESS_KEY });
  t.after(() => fake.close());
  const store = new ObjectStore(config(fake.url));

  const r = await store.storeUpload(upload("q1 report (draft)'s – é.txt", 'first'));
  assert.equal(r.ok, true, r.errorMessage);
  assert.match(r.data.key, /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual({ ...r.data, key: undefined },
    { key: undefined, name: "q1 report (draft)'s – é.txt", size: 5, contentType: 'text/plain' });

  const stored = fake.buckets.get('unit-bucket')?.get(r.data.key);
  assert.ok(stored, 'object is in the bucket');
  assert.equal(stored.body.toString(), 'first');
  assert.equal(stored.contentType, 'text/plain');
  // RFC 5987: ' ( ) * are percent-encoded too, so the header stays one token.
  assert.equal(stored.contentDisposition,
    "attachment; filename*=UTF-8''q1%20report%20%28draft%29%27s%20%E2%80%93%20%C3%A9.txt");

  const second = await store.storeUpload(upload('b.txt', 'second'));
  assert.equal(second.ok, true, second.errorMessage);
  assert.notEqual(second.data.key, r.data.key);
  assert.equal(fake.buckets.get('unit-bucket')?.size, 2);
});

test('a lost CreateBucket race (BucketAlreadyOwnedByYou) still stores the file', async t => {
  const fake = await startFakeS3({ accessKey: ACCESS_KEY });
  t.after(() => fake.close());
  fake.faults.createAnswersOwned = true;
  const r = await new ObjectStore(config(fake.url)).storeUpload(upload());
  assert.equal(r.ok, true, r.errorMessage);
  assert.equal(fake.buckets.get('unit-bucket')?.size, 1);
});

test('storage_error: CreateBucket refused (502)', async t => {
  const fake = await startFakeS3({ accessKey: ACCESS_KEY });
  t.after(() => fake.close());
  fake.faults.denyCreate = true;
  const r = await new ObjectStore(config(fake.url)).storeUpload(upload());
  assert.equal(r.errorCode, 'storage_error');
  assert.match(r.errorMessage, /could not create bucket unit-bucket: AccessDenied/);
  const res = storeUploadFailureResponse(r);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'could not store the file', detail: r.errorMessage, code: 'storage_error' });
});

test('storage_error: the server keeps failing the put (after the SDK\'s retries)', async t => {
  const fake = await startFakeS3({ accessKey: ACCESS_KEY });
  t.after(() => fake.close());
  fake.buckets.set('unit-bucket', new Map());
  fake.faults.failPuts = 10;
  const r = await new ObjectStore(config(fake.url)).storeUpload(upload());
  assert.equal(r.errorCode, 'storage_error');
  assert.match(r.errorMessage, /InternalError/);
  assert.equal(fake.buckets.get('unit-bucket')?.size, 0);
});

test('storage_error: wrong credentials', async t => {
  const fake = await startFakeS3({ accessKey: ACCESS_KEY });
  t.after(() => fake.close());
  const r = await new ObjectStore(config(fake.url, { accessKeyId: 'someone-else' })).storeUpload(upload());
  assert.equal(r.errorCode, 'storage_error');
  assert.match(r.errorMessage, /InvalidAccessKeyId/);
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

// ---------- WEB_PI_S3_* boot checks (src/lib/env.ts) ----------

/** readObjectStoreConfig() in a fresh process (RAW_ENV is read at module load), or its error. */
function bootConfig(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WEB_PI_S3_')));
  try {
    const out = execFileSync(process.execPath, ['-e',
      "process.stdout.write(JSON.stringify(require('./dist-server/src/lib/env.js').readObjectStoreConfig()))"],
      { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { config: JSON.parse(out.toString()) };
  } catch (err) {
    return { error: err.stderr.toString() };
  }
}

test('env: no WEB_PI_S3_* (or only empty ones) is "not configured"', () => {
  assert.deepEqual(bootConfig({}), { config: null });
  assert.deepEqual(bootConfig({ WEB_PI_S3_ENDPOINT: '', WEB_PI_S3_ACCESS_KEY: '' }), { config: null });
});

test('env: endpoint + both keys configure the store, with bucket/region defaults', () => {
  assert.deepEqual(bootConfig({
    WEB_PI_S3_ENDPOINT: 'http://seaweedfs:8333', WEB_PI_S3_ACCESS_KEY: 'a', WEB_PI_S3_SECRET_KEY: 's',
  }), { config: { endpoint: 'http://seaweedfs:8333', accessKeyId: 'a', secretAccessKey: 's', bucket: 'webpi', region: 'us-east-1' } });
});

test('env: a half-configured, non-http or misnamed store stops the boot', () => {
  const keys = { WEB_PI_S3_ACCESS_KEY: 'a', WEB_PI_S3_SECRET_KEY: 's' };
  assert.match(bootConfig({ WEB_PI_S3_ENDPOINT: 'http://seaweedfs:8333', WEB_PI_S3_ACCESS_KEY: 'a' }).error,
    /must be set together/);
  assert.match(bootConfig(keys).error, /must be set together/);
  assert.match(bootConfig({ ...keys, WEB_PI_S3_ENDPOINT: 'seaweedfs:8333' }).error, /is not an http\(s\) URL/);
  assert.match(bootConfig({ ...keys, WEB_PI_S3_ENDPOINT: 'ftp://seaweedfs' }).error, /is not an http\(s\) URL/);
  assert.match(bootConfig({ ...keys, WEB_PI_S3_ENDPOINT: 'http://seaweedfs:8333', WEB_PI_S3_BUCKET: 'Web_Pi' }).error,
    /is not a valid bucket name/);
});
