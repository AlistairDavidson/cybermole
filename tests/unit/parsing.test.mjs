// parsing.service.ts: request parsing and zod validation as Results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  parseAndValidateAPIRequest,
  parseAndValidateFailureToErrors,
  parseAndValidateFormPost,
  parseFileUpload,
  parseRangeRequest,
  parseZod,
  streamFileUpload,
} from '../../dist-server/src/lib/web/parsing.service.js';
import { failureResponse } from '../../dist-server/src/lib/web/responses.service.js';
import { jsonResponse } from '../../dist-server/packages/app-kit/src/web/responses.service.js';

const TestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.email('Invalid email'),
});

const jsonRequest = body =>
  new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const formRequest = data =>
  new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
  });

test('JSON: a valid body parses to the schema output', async () => {
  const r = await parseAndValidateAPIRequest(
    jsonRequest({ name: 'Alice', email: 'alice@example.com' }),
    TestSchema,
  );
  assert.deepEqual(r, {
    ok: true,
    resultType: 'validation',
    data: { name: 'Alice', email: 'alice@example.com' },
  });
});

test('JSON: invalid syntax is invalid_json (400 "Invalid JSON")', async () => {
  const r = await parseAndValidateAPIRequest(
    new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    }),
    TestSchema,
  );
  assert.equal(r.errorCode, 'invalid_json');
  const res = failureResponse(r);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON');
});

test('JSON: a failed schema is validation_failure with the first issue per field (400)', async () => {
  const r = await parseAndValidateAPIRequest(jsonRequest({ name: '', email: 'nope' }), TestSchema);
  assert.equal(r.errorCode, 'validation_failure');
  assert.deepEqual(r.issues, { name: 'Name is required', email: 'Invalid email' });
  const res = failureResponse(r);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: 'name: Name is required',
    code: 'validation_failure',
    issues: r.issues,
  });
});

test('form-urlencoded bodies parse and validate the same way', async () => {
  const good = await parseAndValidateAPIRequest(
    formRequest({ name: 'Bob', email: 'bob@example.com' }),
    TestSchema,
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.data, { name: 'Bob', email: 'bob@example.com' });
  const bad = await parseAndValidateAPIRequest(formRequest({ name: '', email: '' }), TestSchema);
  assert.equal(bad.errorCode, 'validation_failure');
});

test('other content types — and none — are unsupported_content_type (415)', async () => {
  const plain = await parseAndValidateAPIRequest(
    new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    }),
    TestSchema,
  );
  assert.equal(plain.errorCode, 'unsupported_content_type');
  assert.equal(failureResponse(plain).status, 415);
  const none = new Request('http://localhost/test', { method: 'POST', body: 'hello' });
  none.headers.delete('content-type'); // a string body defaults to text/plain
  assert.equal(
    (await parseAndValidateAPIRequest(none, TestSchema)).errorCode,
    'unsupported_content_type',
  );
  const form = new FormData();
  form.append('name', 'Alice');
  const multipart = await parseAndValidateAPIRequest(
    new Request('http://localhost/test', { method: 'POST', body: form }),
    TestSchema,
  );
  assert.equal(multipart.errorCode, 'unsupported_content_type');
});

test('application/json with a charset parameter is still JSON', async () => {
  const r = await parseAndValidateAPIRequest(
    new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
    }),
    TestSchema,
  );
  assert.equal(r.ok, true);
});

test('every failure response is JSON and no-store', async () => {
  const failures = [
    await parseAndValidateAPIRequest(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      }),
      TestSchema,
    ),
    await parseAndValidateAPIRequest(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '',
      }),
      TestSchema,
    ),
    await parseAndValidateAPIRequest(jsonRequest({ name: '' }), TestSchema),
  ];
  for (const r of failures) {
    const res = failureResponse(r);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('parseZod keeps only the first issue per field; root issues key on ""', () => {
  const r = parseZod(
    { value: '' },
    z.object({ value: z.string().min(3, 'Too short').max(5, 'Too long') }),
  );
  assert.deepEqual(r.issues, { value: 'Too short' });
  const root = parseZod(5, z.object({}));
  assert.deepEqual(Object.keys(root.issues), ['']);
});

test('parseAndValidateFailureToErrors: issues for validation, a distinct message per parse code', async () => {
  const invalid = await parseAndValidateFormPost(
    formRequest({ name: '', email: 'nope' }),
    TestSchema,
  );
  assert.deepEqual(parseAndValidateFailureToErrors(invalid), {
    errorMessage: '',
    issues: { name: 'Name is required', email: 'Invalid email' },
  });

  const notAForm = await parseAndValidateFormPost(jsonRequest({ name: 'Alice' }), TestSchema);
  assert.equal(notAForm.errorCode, 'unsupported_content_type');
  const contentType = parseAndValidateFailureToErrors(notAForm);
  assert.match(contentType.errorMessage, /'unsupported content type'/);
  assert.deepEqual(contentType.issues, {});

  const formData = parseAndValidateFailureToErrors({
    ok: false,
    resultType: 'parse_request',
    errorCode: 'invalid_form_data',
  });
  assert.match(formData.errorMessage, /'invalid form data'/);
  assert.notEqual(formData.errorMessage, contentType.errorMessage);
});

const upload = (file, extra = {}) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(extra)) form.append(name, value);
  if (file) form.append('file', file);
  return new Request('http://localhost/up', { method: 'POST', body: form });
};
/** multipart with a declared boundary and this raw body. */
const rawMultipart = (body, boundary = 'XyZ') =>
  new Request('http://localhost/up', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });

test('parseFileUpload: one failure per code (and its status), then the file', async () => {
  const options = { maxSize: 10, allowedMimeTypes: ['image/png'] };
  const notMultipart = await parseFileUpload(jsonRequest({}), options);
  assert.equal(notMultipart.errorCode, 'unsupported_content_type');
  assert.equal(failureResponse(notMultipart).status, 415);
  const broken = await parseFileUpload(rawMultipart('not a multipart body'), options);
  assert.equal(broken.errorCode, 'invalid_form_data');
  assert.equal(failureResponse(broken).status, 400);
  assert.equal((await parseFileUpload(upload(null), options)).errorCode, 'no_file_provided');
  const big = await parseFileUpload(
    upload(new File(['x'.repeat(11)], 'a.png', { type: 'image/png' })),
    options,
  );
  assert.equal(big.errorCode, 'file_too_large');
  assert.equal(failureResponse(big).status, 413);
  assert.equal((await failureResponse(big).json()).error, 'File too large, max size is 0 KiB');
  const kind = await parseFileUpload(
    upload(new File(['x'], 'a.txt', { type: 'text/plain' })),
    options,
  );
  assert.equal(kind.errorCode, 'unsupported_file_type');
  const ok = await parseFileUpload(
    upload(new File(['png'], 'a.png', { type: 'image/png' })),
    options,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.data.buffer.toString(), 'png');
});

// ---------- streamFileUpload ----------

const streamOptions = { maxSize: 64, allowedMimeTypes: ['text/plain'] };

/** A sink that reads the whole stream, like storage does, and records what it saw. */
function readingSink() {
  const seen = { calls: 0, name: null, contentType: null, text: null, error: null };
  const sink = async file => {
    seen.calls++;
    seen.name = file.name;
    seen.contentType = file.contentType;
    try {
      const chunks = [];
      for await (const chunk of file.stream) chunks.push(chunk);
      seen.text = Buffer.concat(chunks).toString();
      return { ok: true, resultType: 'sink', data: { stored: seen.text.length } };
    } catch (err) {
      seen.error = err.message;
      return { ok: false, resultType: 'sink', errorCode: 'sink_failed', errorMessage: err.message };
    }
  };
  return { seen, sink };
}

test('streamFileUpload: the file streams into the sink, whose result is the answer', async () => {
  const { seen, sink } = readingSink();
  const r = await streamFileUpload(
    upload(new File(['hello stream'], 'notes (1).txt', { type: 'text/plain' }), {
      title: 'ignored field',
    }),
    streamOptions,
    sink,
  );
  assert.deepEqual(r, { ok: true, resultType: 'sink', data: { stored: 12 } });
  assert.deepEqual(seen, {
    calls: 1,
    name: 'notes (1).txt',
    contentType: 'text/plain',
    text: 'hello stream',
    error: null,
  });
});

test('streamFileUpload: unsupported_content_type (415) and invalid_form_data (400)', async () => {
  const { seen, sink } = readingSink();
  const json = await streamFileUpload(jsonRequest({}), streamOptions, sink);
  assert.equal(json.errorCode, 'unsupported_content_type');
  assert.equal(failureResponse(json).status, 415);
  const noBoundary = await streamFileUpload(
    new Request('http://localhost/up', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data' },
      body: 'x',
    }),
    streamOptions,
    sink,
  );
  assert.equal(noBoundary.errorCode, 'invalid_form_data');
  const unterminated = await streamFileUpload(
    rawMultipart(
      '--XyZ\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\npartial',
    ),
    streamOptions,
    sink,
  );
  assert.equal(unterminated.errorCode, 'invalid_form_data');
  assert.equal(failureResponse(unterminated).status, 400);
  // The file part had begun, so the sink was reading: it saw an error, not a clean end.
  assert.equal(seen.calls, 1);
  assert.equal(seen.text, null);
  assert.ok(seen.error);
});

test("streamFileUpload: no_file_provided — no file part, another field's file, an empty file input", async () => {
  const { seen, sink } = readingSink();
  assert.equal(
    (await streamFileUpload(upload(null, { title: 'x' }), streamOptions, sink)).errorCode,
    'no_file_provided',
  );
  const otherField = new FormData();
  otherField.append('attachment', new File(['x'], 'a.txt', { type: 'text/plain' }));
  assert.equal(
    (
      await streamFileUpload(
        new Request('http://localhost/up', { method: 'POST', body: otherField }),
        streamOptions,
        sink,
      )
    ).errorCode,
    'no_file_provided',
  );
  // What a browser sends for a file input with nothing chosen.
  const empty = await streamFileUpload(
    rawMultipart(
      '--XyZ\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--XyZ--\r\n',
    ),
    streamOptions,
    sink,
  );
  assert.equal(empty.errorCode, 'no_file_provided');
  assert.equal(seen.calls, 0);
});

test('streamFileUpload: unsupported_file_type is decided before the sink sees a byte', async () => {
  const { seen, sink } = readingSink();
  const r = await streamFileUpload(
    upload(new File(['<b>'], 'a.html', { type: 'text/html' })),
    streamOptions,
    sink,
  );
  assert.equal(r.errorCode, 'unsupported_file_type');
  assert.equal(failureResponse(r).status, 400);
  assert.equal(seen.calls, 0);
});

test("streamFileUpload: file_too_large (413) — the sink sees an error, never a clean end, and its failure doesn't mask the cause", async () => {
  const { seen, sink } = readingSink();
  const r = await streamFileUpload(
    upload(new File(['x'.repeat(10_000)], 'big.txt', { type: 'text/plain' })),
    streamOptions,
    sink,
  );
  assert.equal(r.errorCode, 'file_too_large');
  assert.equal(failureResponse(r).status, 413);
  assert.equal(seen.text, null, 'nothing was stored as if complete');
  assert.equal(seen.error, 'file_too_large');
  // Exactly maxSize is fine.
  const { sink: exact } = readingSink();
  const atLimit = await streamFileUpload(
    upload(new File(['x'.repeat(64)], 'ok.txt', { type: 'text/plain' })),
    streamOptions,
    exact,
  );
  assert.equal(atLimit.ok, true);
});

test('streamFileUpload: a sink that gives up early (storage down) is the answer; the rest of the body is drained', async () => {
  const sinkFailure = { ok: false, resultType: 'sink', errorCode: 'storage_down' };
  const r = await streamFileUpload(
    upload(new File(['x'.repeat(60)], 'a.txt', { type: 'text/plain' })),
    streamOptions,
    async () => sinkFailure,
  );
  assert.equal(r, sinkFailure);
});

test('streamFileUpload: a sink that throws is a bug — it rejects instead of hanging', async () => {
  await assert.rejects(
    streamFileUpload(
      upload(new File(['x'], 'a.txt', { type: 'text/plain' })),
      streamOptions,
      async () => {
        throw new Error('bug');
      },
    ),
    /bug/,
  );
});

test('jsonResponse: status, JSON body, content-type, no-store, extra headers', async () => {
  const res = jsonResponse({ ok: true }, 201, { 'Set-Cookie': 'a=b' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('set-cookie'), 'a=b');
  assert.deepEqual(await res.json(), { ok: true });
});

// ---------- parseRangeRequest ----------

test('parseRangeRequest: one byte range passes through, with If-Range', () => {
  const range = (value, extra = {}) =>
    parseRangeRequest(new Headers({ ...(value === null ? {} : { Range: value }), ...extra }));
  assert.deepEqual(range('bytes=0-99'), { bytes: 'bytes=0-99', ifRange: null });
  assert.deepEqual(range('bytes=100-'), { bytes: 'bytes=100-', ifRange: null });
  assert.deepEqual(range('bytes=-500'), { bytes: 'bytes=-500', ifRange: null });
  assert.deepEqual(
    range(' Bytes=5-5 '),
    { bytes: 'bytes=5-5', ifRange: null },
    'unit is case-insensitive',
  );
  assert.deepEqual(range('bytes=0-', { 'If-Range': '"abc"' }), {
    bytes: 'bytes=0-',
    ifRange: '"abc"',
  });
});

test('parseRangeRequest: anything else is ignored (null = the whole file)', () => {
  const range = value => parseRangeRequest(new Headers(value === null ? {} : { Range: value }));
  for (const ignored of [
    null,
    '',
    'bytes=-',
    'bytes=5-2',
    'bytes=0-1,4-5',
    'items=0-5',
    'bytes=a-b',
    'bytes 0-5',
    'bytes=1234567890123456-',
  ]) {
    assert.equal(range(ignored), null, String(ignored));
  }
});
