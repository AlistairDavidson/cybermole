// The per-app MCP shim as a real stdio child against a stub apps socket:
// table → tools (prefix-free names, emitted schemas), each call → the
// request its entry names, the app's JSON verbatim, the lenient preflight,
// the only isError shapes (host unreachable, apps off), and the boot stops
// (no slug, no build: exit 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SHIM = path.join(REPO, 'dist-server', 'server', 'app-mcp-shim.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-app-shim-'));

const SLUG = 'shim-app';

/** A GET with a required query field, and a POST with a path param and body
 *  fields (flattened, as the binder emits them). */
const TABLE = [
  {
    name: 'ping',
    method: 'GET',
    path: '/api/ping',
    description: 'answers a hello',
    input: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_create',
    method: 'POST',
    path: '/api/notes/:id',
    description: 'creates one note',
    input: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        text: { type: 'string', minLength: 1 },
        tag: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'loose_delete',
    method: 'DELETE',
    path: '/api/loose/:id',
    description: 'deletes loosely',
    input: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

/** Just the emitted table: that and the env are the shim's world. */
const appsRoot = path.join(dir, 'apps');
const tree = path.join(appsRoot, SLUG);
fs.mkdirSync(path.join(tree, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tree, 'app.json'), JSON.stringify({ name: 'Shim App' }));
fs.writeFileSync(path.join(tree, 'dist', 'route-table.json'), JSON.stringify(TABLE, null, 2));
// a tree with no build, for the boot-stop case
fs.mkdirSync(path.join(appsRoot, 'unbuilt-app'), { recursive: true });
fs.writeFileSync(
  path.join(appsRoot, 'unbuilt-app', 'app.json'),
  JSON.stringify({ name: 'Unbuilt' }),
);

/** Records every request, answers canned JSON per method+URL. */
const seen = [];
const answerFor = (method, url) => {
  if (method === 'GET' && url === '/apps/shim-app/api/ping?name=unit')
    return { status: 200, body: { ok: true, resultType: 'ping', data: { hello: 'unit' } } };
  if (method === 'POST' && url === '/apps/shim-app/api/notes/7')
    return {
      status: 201,
      body: { ok: true, resultType: 'note_create', data: { id: 7, title: 't' } },
    };
  if (method === 'GET' && url.startsWith('/apps/shim-app/api/ping'))
    return {
      status: 400,
      body: {
        ok: false,
        resultType: 'route_api',
        errorCode: 'invalid_query',
        issues: { name: 'name is required' },
      },
    };
  return { status: 404, body: { error: 'no such app', code: 'app_not_mounted' } };
};
const hostSocket = path.join(dir, 'apps.sock');
const host = await new Promise(resolve => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => {
      body += c;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      const canned = answerFor(req.method ?? '', req.url ?? '');
      res.writeHead(canned.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(canned.body));
    });
  });
  server.listen(hostSocket, () => resolve(server));
});

/** Tracked so a test that throws still gets its child closed (a leaked
 *  stdio child hangs the run). */
const clients = [];
const boot = async env => {
  const client = new Client({ name: 'shim-unit', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SHIM, SLUG],
      env,
    }),
  );
  clients.push(client);
  return client;
};
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args ?? {} });
  return { isError: r.isError === true, text: r.content.map(c => c.text ?? '').join('') };
};

test('the table→tool translation: tools 1:1 with route-table.json, names prefix-free, schemas from the emitted input', async () => {
  const client = await boot({ CYBERMOLE_APPS_ROOT: appsRoot, CYBERMOLE_APPS_SOCK: hostSocket });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(t => t.name),
    ['ping', 'note_create', 'loose_delete'],
    'the table names, verbatim — the MCP registration is the namespace',
  );
  const ping = tools.tools[0];
  assert.match(ping.description, /^answers a hello — GET \/apps\/shim-app\/api\/ping/);
  assert.equal(ping.inputSchema.type, 'object');
  assert.equal(ping.inputSchema.properties.name.type, 'string');
  assert.deepEqual(ping.inputSchema.required, ['name']);
  const note = tools.tools[1];
  assert.equal(note.inputSchema.properties.id.type, 'integer');
  assert.deepEqual(note.inputSchema.properties.tag.enum, ['a', 'b']);
  await client.close();
});

test('a tool call is THE request the entry names — GET query, POST path+body; the Result JSON verbatim', async () => {
  const client = await boot({ CYBERMOLE_APPS_ROOT: appsRoot, CYBERMOLE_APPS_SOCK: hostSocket });
  const pong = await call(client, 'ping', { name: 'unit' });
  assert.equal(pong.isError, false, pong.text);
  assert.deepEqual(JSON.parse(pong.text), {
    ok: true,
    resultType: 'ping',
    data: { hello: 'unit' },
  });
  assert.deepEqual(seen.at(-1), {
    method: 'GET',
    url: '/apps/shim-app/api/ping?name=unit',
    body: '',
  });

  const made = await call(client, 'note_create', { id: 7, text: 'hi', tag: 'b' });
  assert.equal(made.isError, false, made.text);
  assert.deepEqual(JSON.parse(made.text), {
    ok: true,
    resultType: 'note_create',
    data: { id: 7, title: 't' },
  });
  assert.deepEqual(seen.at(-1), {
    method: 'POST',
    url: '/apps/shim-app/api/notes/7',
    body: JSON.stringify({ text: 'hi', tag: 'b' }),
  });
  await client.close();
});

test("domain answers stay normal results: the app's failure JSON verbatim; invalid params answered locally, the app never called", async () => {
  const client = await boot({ CYBERMOLE_APPS_ROOT: appsRoot, CYBERMOLE_APPS_SOCK: hostSocket });
  // the app's own 404, verbatim
  const notFound = await call(client, 'note_create', { id: 9, text: 'x' });
  assert.equal(notFound.isError, false, notFound.text);
  assert.deepEqual(JSON.parse(notFound.text), { error: 'no such app', code: 'app_not_mounted' });
  // A schema that missed a path param's requiredness still can't send a
  // broken request: the shim answers locally.
  const before = seen.length;
  const local = await call(client, 'loose_delete', { text: 'no id' });
  assert.equal(local.isError, false, local.text);
  const parsed = JSON.parse(local.text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errorCode, 'invalid_params');
  assert.equal(parsed.issues.id, 'id is required');
  assert.equal(parsed.issues.id, 'id is required');
  assert.equal(seen.length, before);
  await client.close();
});

test('transport failures are the only isError: the host unreachable, the apps surface off', async () => {
  const gone = await boot({
    CYBERMOLE_APPS_ROOT: appsRoot,
    CYBERMOLE_APPS_SOCK: path.join(dir, 'nothing-here.sock'),
  });
  const unreachable = await call(gone, 'ping', { name: 'x' });
  assert.equal(unreachable.isError, true);
  assert.match(unreachable.text, /could not reach the app host/);
  assert.match(unreachable.text, /ENOENT/);
  await gone.close();

  const off = await boot({ CYBERMOLE_APPS_ROOT: appsRoot, CYBERMOLE_APPS_SOCK: '' });
  const offCall = await call(off, 'ping', { name: 'x' });
  assert.equal(offCall.isError, true);
  assert.match(offCall.text, /CYBERMOLE_APPS_SOCK is empty/);
  await off.close();
});

test('boot stops loud: a missing slug or an unbuilt tree is stderr + exit 1, not a silent no-tool server', async () => {
  const run = (args, env) =>
    new Promise(resolve => {
      const child = spawn(process.execPath, [SHIM, ...args], { env: { ...process.env, ...env } });
      let stderr = '';
      child.stderr.on('data', c => {
        stderr += c;
      });
      child.on('close', code => resolve({ code, stderr }));
    });
  const noSlug = await run([], {});
  assert.equal(noSlug.code, 1);
  assert.match(noSlug.stderr, /usage: app-mcp-shim\.js <slug>/);
  const unbuilt = await run(['unbuilt-app'], {
    CYBERMOLE_APPS_ROOT: appsRoot,
    CYBERMOLE_APPS_SOCK: hostSocket,
  });
  assert.equal(unbuilt.code, 1);
  assert.match(unbuilt.stderr, /no dist\/route-table\.json/);
  assert.match(unbuilt.stderr, /build/);
});

test.after(() => {
  // close every client (a leaked child hangs the run), then the stub host
  for (const c of clients) c.close().catch(() => undefined);
  host.close();
});
