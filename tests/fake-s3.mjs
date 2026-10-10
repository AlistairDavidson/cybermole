// fake-s3.mjs — a tiny in-memory S3 for the tests: only the calls
// src/lib/storage.ts makes (path-style CreateBucket and PutObject), plus a
// test-side read-back under /__fake/ (underscores can't start a bucket
// name, so it never collides). Not an S3 implementation: the signature is
// checked for the right access key, not verified; no listing, no multipart.
//
// Imported by the unit tests (startFakeS3), and run as a process by the
// e2e suite's webServer list (playwright.config.ts):
//   node tests/fake-s3.mjs <port> <accessKey>
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ body: Buffer, contentType: string | undefined, contentDisposition: string | undefined }} FakeObject
 * @typedef {{
 *   url: string,
 *   buckets: Map<string, Map<string, FakeObject>>,
 *   faults: { failPuts: number, createAnswersOwned: boolean, denyCreate: boolean },
 *   close: () => Promise<void>,
 * }} FakeS3
 */

/** @param {string} code @param {number} status @param {http.ServerResponse} res */
function s3Error(res, status, code) {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

/**
 * @param {{ port?: number, accessKey: string }} options
 * @returns {Promise<FakeS3>}
 */
export function startFakeS3({ port = 0, accessKey }) {
  /** @type {Map<string, Map<string, FakeObject>>} */
  const buckets = new Map();
  // Test-set misbehaviour: the next N puts fail 500; CreateBucket creates
  // but answers BucketAlreadyOwnedByYou (a lost race); CreateBucket is refused.
  const faults = { failPuts: 0, createAnswersOwned: false, denyCreate: false };

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);

      if (segments[0] === '__fake') {
        if (segments[1] === 'health') { res.end('ok'); return; }
        const object = segments[1] === 'objects' ? buckets.get(segments[2] ?? '')?.get(segments.slice(3).join('/')) : undefined;
        if (!object) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...object, body: object.body.toString('base64') }));
        return;
      }

      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKey}/`)) { s3Error(res, 403, 'InvalidAccessKeyId'); return; }

      const [bucket = '', ...keyParts] = segments;
      const key = keyParts.join('/');
      if (req.method === 'PUT' && key === '') {
        if (faults.denyCreate) { s3Error(res, 403, 'AccessDenied'); return; }
        const existed = buckets.has(bucket);
        if (!existed) buckets.set(bucket, new Map());
        if (existed || faults.createAnswersOwned) { s3Error(res, 409, 'BucketAlreadyOwnedByYou'); return; }
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'PUT') {
        if (faults.failPuts > 0) { faults.failPuts--; s3Error(res, 500, 'InternalError'); return; }
        const objects = buckets.get(bucket);
        if (!objects) { s3Error(res, 404, 'NoSuchBucket'); return; }
        objects.set(key, {
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'],
          contentDisposition: req.headers['content-disposition'],
        });
        res.writeHead(200, { ETag: '"fake"' }).end();
        return;
      }
      s3Error(res, 501, 'NotImplemented');
    });
  });

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        buckets,
        faults,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [port, accessKey] = process.argv.slice(2);
  if (!port || !accessKey) throw new Error('usage: node tests/fake-s3.mjs <port> <accessKey>');
  const fake = await startFakeS3({ port: Number(port), accessKey });
  console.log(`fake S3 on ${fake.url}`);
}
