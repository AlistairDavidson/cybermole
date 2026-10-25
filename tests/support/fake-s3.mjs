// A tiny in-memory S3 with only the calls storage.ts makes, plus a test
// read-back under /__fake/ (no bucket name can start with "_"). The
// signature's access key is checked, not verified. Used by the unit tests
// (startFakeS3) and run by the e2e webServer list:
//   node tests/support/fake-s3.mjs <port> <accessKey>
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ body: Buffer, contentType: string | undefined, contentDisposition: string | undefined, lastModified: Date }} FakeObject
 * @typedef {{ bucket: string, key: string, contentType: string | undefined, contentDisposition: string | undefined, parts: Map<number, Buffer> }} FakeMultipart
 * @typedef {{
 *   url: string,
 *   buckets: Map<string, Map<string, FakeObject>>,
 *   multipart: Map<string, FakeMultipart>,
 *   stats: { creates: number, aborted: number, completed: number, heads: number, ranges: string[] },
 *   faults: { failPuts: number, failGets: boolean, headStatus: number | null, createAnswersOwned: boolean, denyCreate: boolean },
 *   close: () => Promise<void>,
 * }} FakeS3
 */

/** @param {http.ServerResponse} res @param {number} status @param {string} code */
function s3Error(res, status, code) {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
  );
}

/** @param {FakeObject} object @param {number} length */
function objectHeaders(object, length) {
  return {
    'Content-Length': String(length),
    'Last-Modified': object.lastModified.toUTCString(),
    'Accept-Ranges': 'bytes',
    ETag: '"fake"',
    ...(object.contentType ? { 'Content-Type': object.contentType } : {}),
    ...(object.contentDisposition ? { 'Content-Disposition': object.contentDisposition } : {}),
  };
}

/** @param {http.ServerResponse} res @param {string} xml */
function xmlOk(res, xml) {
  res.writeHead(200, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
}

/**
 * @param {{ port?: number, accessKey: string }} options
 * @returns {Promise<FakeS3>}
 */
export function startFakeS3({ port = 0, accessKey }) {
  /** @type {Map<string, Map<string, FakeObject>>} */
  const buckets = new Map();
  /** @type {Map<string, FakeMultipart>} */
  const multipart = new Map();
  const stats = { creates: 0, aborted: 0, completed: 0, heads: 0, ranges: [] };
  // Injected faults: failing puts and gets, a HeadBucket status, a
  // CreateBucket that answers BucketAlreadyOwnedByYou (a lost race), or a refused one.
  const faults = {
    failPuts: 0,
    failGets: false,
    headStatus: null,
    createAnswersOwned: false,
    denyCreate: false,
  };
  let nextUploadId = 1;

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);

      if (segments[0] === '__fake') {
        if (segments[1] === 'health') {
          res.end('ok');
          return;
        }
        const object =
          segments[1] === 'objects'
            ? buckets.get(segments[2] ?? '')?.get(segments.slice(3).join('/'))
            : undefined;
        if (!object) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...object, body: object.body.toString('base64') }));
        return;
      }

      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKey}/`)) {
        s3Error(res, 403, 'InvalidAccessKeyId');
        return;
      }

      const [bucket = '', ...keyParts] = segments;
      const key = keyParts.join('/');
      const objects = buckets.get(bucket);
      const uploadId = url.searchParams.get('uploadId');
      const meta = () => ({
        contentType: req.headers['content-type'],
        contentDisposition: req.headers['content-disposition'],
      });

      // ---- bucket calls
      if (key === '' && req.method === 'HEAD') {
        res.writeHead(faults.headStatus ?? (objects ? 200 : 404)).end();
        return;
      }
      if (key === '' && req.method === 'PUT') {
        if (faults.denyCreate) {
          s3Error(res, 403, 'AccessDenied');
          return;
        }
        stats.creates++;
        if (!objects) buckets.set(bucket, new Map());
        if (objects || faults.createAnswersOwned) {
          s3Error(res, 409, 'BucketAlreadyOwnedByYou');
          return;
        }
        res.writeHead(200).end();
        return;
      }

      // ---- object calls
      if (req.method === 'HEAD') {
        // HeadObject: no error body, like S3
        stats.heads++;
        const object = objects?.get(key);
        if (faults.failGets) {
          res.writeHead(500).end();
          return;
        }
        if (!object) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, objectHeaders(object, object.body.length)).end();
        return;
      }
      if (!objects) {
        s3Error(res, 404, 'NoSuchBucket');
        return;
      }
      if (req.method === 'GET') {
        if (faults.failGets) {
          s3Error(res, 500, 'InternalError');
          return;
        }
        const object = objects.get(key);
        if (!object) {
          s3Error(res, 404, 'NoSuchKey');
          return;
        }
        const range = req.headers.range;
        if (range) {
          stats.ranges.push(range);
          const size = object.body.length;
          const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(range) ?? [];
          const start = first ? Number(first) : Math.max(0, size - Number(last));
          const end = first ? Math.min(size - 1, last ? Number(last) : size - 1) : size - 1;
          if (start >= size || (!first && Number(last) === 0)) {
            s3Error(res, 416, 'InvalidRange');
            return;
          }
          res.writeHead(206, {
            ...objectHeaders(object, end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
          });
          res.end(object.body.subarray(start, end + 1));
          return;
        }
        res.writeHead(200, objectHeaders(object, object.body.length));
        res.end(object.body);
        return;
      }
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        // CreateMultipartUpload
        const id = `upload-${nextUploadId++}`;
        multipart.set(id, { bucket, key, ...meta(), parts: new Map() });
        xmlOk(
          res,
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }
      if (req.method === 'PUT') {
        // PutObject or UploadPart
        if (faults.failPuts > 0) {
          faults.failPuts--;
          s3Error(res, 500, 'InternalError');
          return;
        }
        if (uploadId) {
          const upload = multipart.get(uploadId);
          if (!upload) {
            s3Error(res, 404, 'NoSuchUpload');
            return;
          }
          const partNumber = Number(url.searchParams.get('partNumber'));
          upload.parts.set(partNumber, Buffer.concat(chunks));
          res.writeHead(200, { ETag: `"part-${partNumber}"` }).end();
          return;
        }
        objects.set(key, { body: Buffer.concat(chunks), ...meta(), lastModified: new Date() });
        res.writeHead(200, { ETag: '"fake"' }).end();
        return;
      }
      if (req.method === 'POST' && uploadId) {
        // CompleteMultipartUpload
        const upload = multipart.get(uploadId);
        if (!upload) {
          s3Error(res, 404, 'NoSuchUpload');
          return;
        }
        multipart.delete(uploadId);
        const ordered = [...upload.parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, part]) => part);
        objects.set(key, {
          body: Buffer.concat(ordered),
          contentType: upload.contentType,
          contentDisposition: upload.contentDisposition,
          lastModified: new Date(),
        });
        stats.completed++;
        xmlOk(
          res,
          `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>"fake"</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }
      if (req.method === 'DELETE' && uploadId) {
        // AbortMultipartUpload
        multipart.delete(uploadId);
        stats.aborted++;
        res.writeHead(204).end();
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
        multipart,
        stats,
        faults,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [port, accessKey] = process.argv.slice(2);
  if (!port || !accessKey)
    throw new Error('usage: node tests/support/fake-s3.mjs <port> <accessKey>');
  const fake = await startFakeS3({ port: Number(port), accessKey });
  console.log(`fake S3 on ${fake.url}`);
}
