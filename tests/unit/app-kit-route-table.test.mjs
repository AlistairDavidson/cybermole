// app-kit-route-table.test.mjs — the kit's route-table binder
// (packages/app-kit/src/route-table.ts + route-table-emit.ts,
// docs/apps-plan.md §5/§10): one small table bound to every face —
// (a) the HTTP glue (match, zod parse, handler, Result→status; unknown
//     route 404, wrong method 405, binder-own input failures, a thrown
//     handler, basePath stripping),
// (b) MCP tool shapes (names, descriptions, the flattened JSON-schema
//     input via the documented zod subset),
// (c) the typed client (params interpolation, query, JSON body, Result
//     passthrough, transport failures),
// (d) serializeRouteTable + writeRouteTable (the dist/route-table.json
//     artifact).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import {
  defineRoute,
  handleApiRequest,
  astroApiHandlers,
  toMcpToolShapes,
  zodToJSONSchema,
  serializeRouteTable,
  createRouteClient,
} from '../../dist-server/packages/app-kit/src/route-table.js';
import { writeRouteTable } from '../../dist-server/packages/app-kit/src/route-table-emit.js';

// The fixture table: a notes app's three actions, one per shape.
const noteCreate = defineRoute({
  name: 'note_create',
  description: 'creates one note',
  method: 'POST',
  path: '/api/notes',
  params: z.object({}),
  body: z.object({ title: z.string().min(1).describe('the title'), body: z.string() }),
  errorStatus: { invalid_title: 400, database_error: 500 },
  successStatus: 201,
  handler: async ({ body }) => {
    if (body.title === 'x') return invalidTitle();
    return {
      ok: true,
      resultType: 'note_create',
      data: { id: 7, title: body.title },
    };
  },
});
const invalidTitle = () => ({
  ok: false,
  resultType: 'note_create',
  errorCode: 'invalid_title',
  errorMessage: 'that title is not allowed',
});
const noteGet = defineRoute({
  name: 'note_get',
  description: 'reads one note by id',
  method: 'GET',
  path: '/api/notes/:id',
  params: z.object({ id: z.coerce.number().int().gte(1) }),
  errorStatus: { note_not_found: 404 },
  handler: ({ params }) => {
    if (params.id !== 7)
      return {
        ok: false,
        resultType: 'note_get',
        errorCode: 'note_not_found',
        errorMessage: `no note ${params.id}`,
      };
    return { ok: true, resultType: 'note_get', data: { id: 7, title: 'first' } };
  },
});
const noteList = defineRoute({
  name: 'note_list',
  description: 'lists notes, optionally filtered',
  method: 'GET',
  path: '/api/notes',
  params: z.object({}),
  query: z.object({ q: z.string().optional(), tag: z.enum(['a', 'b']) }),
  errorStatus: { database_error: 500 },
  handler: ({ query }) => ({
    ok: true,
    resultType: 'note_list',
    data: { notes: [], q: query.q ?? null, tag: query.tag },
  }),
});
const throwing = defineRoute({
  name: 'boom',
  description: 'always throws',
  method: 'GET',
  path: '/api/boom',
  params: z.object({}),
  errorStatus: {},
  handler: () => {
    throw new Error('kaboom');
  },
});

const table = [noteCreate, noteGet, noteList, throwing];

const call = (entry, input) => entry.handler(input);
const json = async res => ({ status: res.status, body: await res.json() });

// ---------- (a) the HTTP face ----------

test('handleApiRequest: success answers the Result verbatim at the entry status', async () => {
  const res = await handleApiRequest(
    new Request('http://app/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'first', body: 'hello' }),
    }),
    table,
  );
  const { status, body } = await json(res);
  assert.equal(status, 201); // successStatus
  assert.deepEqual(body, { ok: true, resultType: 'note_create', data: { id: 7, title: 'first' } });
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('handleApiRequest: a handler failure maps through the entry errorStatus, body verbatim', async () => {
  const res = await handleApiRequest(new Request('http://app/api/notes/9'), table);
  const { status, body } = await json(res);
  assert.equal(status, 404); // note_not_found
  assert.deepEqual(body, {
    ok: false,
    resultType: 'note_get',
    errorCode: 'note_not_found',
    errorMessage: 'no note 9',
  });
});

test('handleApiRequest: params are strings→coerced; a failing params schema is 400 invalid_params with issues', async () => {
  const res = await handleApiRequest(new Request('http://app/api/notes/zero'), table);
  const { status, body } = await json(res);
  assert.equal(status, 400);
  assert.equal(body.errorCode, 'invalid_params');
  assert.equal(body.resultType, 'route_api');
  assert.ok(body.issues.id);
});

test('handleApiRequest: the query schema parses; a failing one is 400 invalid_query', async () => {
  const ok = await json(
    await handleApiRequest(new Request('http://app/api/notes?q=hi&tag=a'), table),
  );
  assert.deepEqual(ok.body.data, { notes: [], q: 'hi', tag: 'a' });

  const bad = await json(
    await handleApiRequest(new Request('http://app/api/notes?tag=zzz'), table),
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errorCode, 'invalid_query');
  assert.ok(bad.body.issues.tag);
});

test('handleApiRequest: body handling — 415 non-JSON, 400 invalid JSON, 400 invalid_body with issues', async () => {
  const post = (body, type = 'application/json') =>
    handleApiRequest(
      new Request('http://app/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': type },
        body,
      }),
      table,
    );
  assert.equal((await json(await post('hi', 'text/plain'))).status, 415);
  const notJson = await json(await post('{oops'));
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.errorCode, 'invalid_json');
  const bad = await json(await post(JSON.stringify({ title: '', body: 'x' })));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errorCode, 'invalid_body');
  assert.ok(bad.body.issues.title);
});

test('handleApiRequest: unknown path 404, known path wrong method 405 with Allow', async () => {
  const notFound = await json(await handleApiRequest(new Request('http://app/api/nope'), table));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.errorCode, 'route_not_found');

  const res = await handleApiRequest(
    new Request('http://app/api/notes/7', { method: 'DELETE' }),
    table,
  );
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('handleApiRequest: a thrown handler is a 500 internal_error Result, not a crash', async () => {
  const { status, body } = await json(
    await handleApiRequest(new Request('http://app/api/boom'), table),
  );
  assert.equal(status, 500);
  assert.equal(body.errorCode, 'internal_error');
  assert.match(body.errorMessage, /kaboom/);
});

test('handleApiRequest: basePath is stripped before matching (the baked app base)', async () => {
  const res = await handleApiRequest(new Request('http://app/apps/notes/api/notes/7'), table, {
    basePath: '/apps/notes',
  });
  const { status, body } = await json(res);
  assert.equal(status, 200);
  assert.deepEqual(body.data, { id: 7, title: 'first' });
});

test('astroApiHandlers: every method delegates to the same glue', async () => {
  const handlers = astroApiHandlers(table);
  assert.deepEqual(Object.keys(handlers).sort(), ['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
  const res = await handlers.GET({ request: new Request('http://app/api/notes/7') });
  assert.equal(res.status, 200);
});

// ---------- (b) MCP tool shapes ----------

test('toMcpToolShapes: one tool per entry, flattened input schema over the documented subset', () => {
  const tools = toMcpToolShapes(table);
  assert.deepEqual(
    tools.map(t => t.name),
    ['note_create', 'note_get', 'note_list', 'boom'],
  );
  const create = tools[0];
  assert.equal(create.description, 'creates one note');
  assert.deepEqual(create.inputSchema.required, ['title', 'body']);
  assert.equal(create.inputSchema.properties.title.type, 'string');
  assert.equal(create.inputSchema.properties.title.minLength, 1);
  assert.equal(create.inputSchema.properties.title.description, 'the title');
  const get = tools[1];
  assert.deepEqual(get.inputSchema.properties.id, { type: 'integer', minimum: 1 });
  const list = tools[2];
  assert.deepEqual(list.inputSchema.properties.q, { type: 'string' }); // optional: not in required
  assert.deepEqual(list.inputSchema.properties.tag, { type: 'string', enum: ['a', 'b'] });
  assert.equal(list.inputSchema.additionalProperties, false);
});

test('zodToJSONSchema: the documented subset — nullable, union, array, record, literal, unknown→{}', () => {
  assert.deepEqual(zodToJSONSchema(z.string().nullable()), {
    anyOf: [{ type: 'string' }, { type: 'null' }],
  });
  assert.deepEqual(zodToJSONSchema(z.array(z.number().int())), {
    type: 'array',
    items: { type: 'integer' },
  });
  assert.deepEqual(zodToJSONSchema(z.record(z.string(), z.boolean())), {
    type: 'object',
    additionalProperties: { type: 'boolean' },
  });
  assert.deepEqual(zodToJSONSchema(z.literal('x')), { const: 'x' });
  assert.deepEqual(zodToJSONSchema(z.union([z.literal('a'), z.literal('b')])), {
    anyOf: [{ const: 'a' }, { const: 'b' }],
  });
  assert.deepEqual(zodToJSONSchema(z.date()), {}); // permissive, never wrong
  const num = zodToJSONSchema(z.number().gte(0).lte(10));
  assert.deepEqual(num, { type: 'number', minimum: 0, maximum: 10 });
});

// ---------- (c) the typed client ----------

test('createRouteClient: interpolates params, sends query and JSON body, returns the Result JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, resultType: 'note_get', data: { id: 7 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createRouteClient(table, { base: 'http://host/apps/notes', fetchImpl });

  const got = await client.note_get({ params: { id: 7 } });
  assert.deepEqual(got, { ok: true, resultType: 'note_get', data: { id: 7 } });
  assert.equal(calls[0].url, 'http://host/apps/notes/api/notes/7');
  assert.equal(calls[0].init.method, 'GET');

  await client.note_list({ params: {}, query: { q: 'hi', tag: 'a' } });
  assert.equal(calls[1].url, 'http://host/apps/notes/api/notes?q=hi&tag=a');

  await client.note_create({ params: {}, body: { title: 't', body: 'b' } });
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(calls[2].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[2].init.body, JSON.stringify({ title: 't', body: 'b' }));
});

test('createRouteClient: network failure and non-JSON answers are transport_error', async () => {
  const boom = createRouteClient(table, {
    base: 'http://host',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const failed = await boom.note_get({ params: { id: 7 } });
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'transport_error');
  assert.match(failed.errorMessage, /note_get: ECONNREFUSED/);

  const html = createRouteClient(table, {
    base: 'http://host',
    fetchImpl: async () => new Response('<html>502</html>', { status: 502 }),
  });
  const notJson = await html.note_get({ params: { id: 7 } });
  assert.equal(notJson.errorCode, 'transport_error');
  assert.match(notJson.errorMessage, /non-JSON answer \(status 502\)/);
});

// ---------- (d) the emitted table ----------

test('serializeRouteTable: name, method, path, description, input per entry', () => {
  const serialized = serializeRouteTable(table);
  assert.deepEqual(
    serialized.map(e => ({ name: e.name, method: e.method, path: e.path })),
    [
      { name: 'note_create', method: 'POST', path: '/api/notes' },
      { name: 'note_get', method: 'GET', path: '/api/notes/:id' },
      { name: 'note_list', method: 'GET', path: '/api/notes' },
      { name: 'boom', method: 'GET', path: '/api/boom' },
    ],
  );
  assert.equal(serialized[0].description, 'creates one note');
  assert.equal(serialized[1].input.properties.id.type, 'integer');
});

test('writeRouteTable: writes pretty JSON (dir created) that round-trips', () => {
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kit-routes-')),
    'dist',
    'route-table.json',
  );
  writeRouteTable(table, out);
  const read = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(read.length, 4);
  assert.deepEqual(read[1].input.properties.id, { type: 'integer', minimum: 1 });
});

test('defineRoute: the fixture handlers still run directly (the table stays plain data)', async () => {
  // the binder never wraps handlers: the entries a client or tool shape
  // describe are callable as-is
  assert.equal(
    (await call(noteGet, { params: { id: 7 }, query: undefined, body: undefined })).ok,
    true,
  );
  assert.equal(
    (await call(noteCreate, { params: {}, query: undefined, body: { title: 'x', body: '' } }))
      .errorCode,
    'invalid_title',
  );
});
