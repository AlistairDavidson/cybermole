// apps-actions.ts: the name rule, the light route-table parse, AGENTS.md
// block regeneration, and add_action against real scaffolded trees (write
// order, refusals, GET, missing markers). apps-route-table.ts: reading the
// emitted table, lenient preflight, request planning and typed shapes.
// apps-mcp.ts describe/call against a stub apps socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-apps-actions-'));

const { scaffoldApp } = await import('../../dist-server/src/lib/apps/apps-scaffold.js');
const { runChild } = await import('../../dist-server/src/lib/apps/apps-child.js');
const {
  addAction,
  normalizeActionName,
  parseRouteTableSource,
  regenerateAgentsActions,
  ACTION_NAME_RE,
} = await import('../../dist-server/src/lib/apps/apps-actions.js');
const { readRouteTable, findAction, planActionRequest, lenientPreflight, shapeFromJsonSchema } =
  await import('../../dist-server/src/lib/apps/apps-route-table.js');
const { describeTool, callActionTool } = await import('../../dist-server/server/apps-mcp.js');

const scaffoldDeps = root => ({
  appsRoot: root,
  templateDir: path.join(REPO, 'runtime', 'app-starter'),
  agentTemplateFile: path.join(REPO, 'runtime', 'app-agents', 'AGENTS.md'),
  installRoot: REPO,
  run: runChild,
});

async function world(label) {
  const root = fs.mkdtempSync(path.join(dir, `${label}-`));
  const r = await scaffoldApp(scaffoldDeps(root), {
    name: `${label} Probe`,
    description: 'the unit-run tree',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { root, slug: r.data.slug, tree: r.data.tree };
}

// ---------- action names ----------

test('the action-name rule: normalizeSlug rules with underscores kept, capped, defined once', () => {
  assert.equal(normalizeActionName('Create Note!'), 'create-note');
  assert.equal(normalizeActionName('note_create'), 'note_create'); // snake stays
  assert.equal(normalizeActionName('  Mixed--Case__Run  '), 'mixed-case__run');
  assert.equal(normalizeActionName('!!!'), '');
  assert.equal(normalizeActionName('_note_'), 'note'); // edge underscores strip (the RE's [a-z0-9] edges)
  assert.equal(normalizeActionName(`x`.repeat(60)), 'x'.repeat(40));
  for (const good of ['ping', 'note-create', 'note_create', 'a', 'a9-b_9']) {
    assert.match(good, ACTION_NAME_RE, good);
  }
  for (const bad of ['', 'Ping', 'note!', '-note', '_note']) {
    assert.doesNotMatch(bad, ACTION_NAME_RE, bad);
  }
});

// ---------- light parse ----------

test('parseRouteTableSource: the starter template parses — ping, its query field, multiline zod chains', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'runtime', 'app-starter', 'src', 'routes.ts'),
    'utf8',
  );
  const actions = parseRouteTableSource(source);
  assert.deepEqual(actions, [
    {
      name: 'ping',
      description: 'answers a hello — the scaffolded example action, wired end to end',
      method: 'GET',
      path: '/api/ping',
      fields: [{ name: 'name', type: 'string', optional: false }],
    },
  ]);
});

test('parseRouteTableSource: params+query+body fields, optional ones, quotes inside descriptions, unparsable entries skipped', () => {
  const source = `
export const routes: RouteTable = [
  defineRoute({
    name: 'note_create',
    description: 'creates one note (the "quick" kind) — with a } brace',
    method: 'POST',
    path: '/api/notes/:id',
    params: z.object({
      id: z.coerce.number().int().gte(1),
    }),
    query: z.object({
      quiet: z.boolean().optional(),
    }),
    body: z.object({
      text: z.string().min(1),
      tag: z.enum(['a', 'b']),
    }),
    errorStatus: { invalid_text: 400 },
    handler: ({ body }) => noteCreateResult(body.text),
  }),
  defineRoute({ notAnEntry: true }),
  {
    name: 'not even a route',
  },
];
`;
  const actions = parseRouteTableSource(source);
  assert.equal(actions.length, 1);
  const entry = actions[0];
  assert.equal(entry.name, 'note_create');
  assert.equal(entry.method, 'POST');
  assert.equal(entry.path, '/api/notes/:id');
  assert.deepEqual(entry.fields, [
    { name: 'id', type: 'number', optional: false },
    { name: 'quiet', type: 'boolean', optional: true },
    { name: 'text', type: 'string', optional: false },
    { name: 'tag', type: 'enum', optional: false },
  ]);
});

test('parseRouteTableSource: a field NAMED body/query/params is a field, not a namespace (the notes app)', () => {
  const source = `
export const routes: RouteTable = [
  defineRoute({
    name: 'note_create',
    description: 'capture a note — a body field inside the body schema',
    method: 'POST',
    path: '/api/notes',
    params: z.object({}),
    body: z.object({
      title: z.string(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    errorStatus: { invalid_title: 400 },
    handler: ({ body }) => noteCreateResult(notesStore(), body),
  }),
];
`;
  const actions = parseRouteTableSource(source);
  assert.deepEqual(actions[0].fields, [
    { name: 'title', type: 'string', optional: false },
    { name: 'body', type: 'string', optional: true },
    // best-effort: z.array(z.string()) reads as 'string'
    { name: 'tags', type: 'string', optional: true },
  ]);
});

// ---------- AGENTS.md regeneration ----------

test('the AGENTS.md block regeneration round-trips: idempotent, table-driven, markers preserved', async () => {
  const { root, slug, tree } = await world('regen');
  assert.equal(
    (await addAction({ appsRoot: root }, { slug, name: 'note', summary: 'captures a note' })).ok,
    true,
  );
  const agentsPath = path.join(tree, 'AGENTS.md');
  const once = fs.readFileSync(agentsPath, 'utf8');
  // both actions, ping's regenerated in the same shape as note's
  const block = once.match(/<!-- BEGIN ACTIONS[\s\S]*?<!-- END ACTIONS -->/)[0];
  assert.match(
    block,
    /### ping\n\nanswers a hello[\s\S]*?- call: the `ping` MCP tool[\s\S]*?`GET \/apps\/regen-probe\/api\/ping`\n- input: `name` \(string, required\)/,
  );
  assert.match(
    block,
    /### note\n\ncaptures a note\n- call: the `note` MCP tool[\s\S]*?`POST \/apps\/regen-probe\/api\/note`\n- input: `text` \(string, required\)/,
  );
  assert.equal(block.indexOf('### ping') < block.indexOf('### note'), true); // table order: ping first
  // idempotent: the same table writes the same file
  const routes = fs.readFileSync(path.join(tree, 'src', 'routes.ts'), 'utf8');
  const regen = regenerateAgentsActions(once, slug, parseRouteTableSource(routes));
  assert.equal(regen.appendedFresh, false);
  assert.equal(regen.text, once);
  // everything outside the block is byte-identical to the template
  const seeded = fs.readFileSync(path.join(tree, 'AGENTS.md'), 'utf8');
  assert.ok(seeded.includes('## Policy'));
});

test('the AGENTS.md regeneration inserts a fresh section when the markers are gone', () => {
  const text = '# AGENTS.md — operating X\n\nintro\n\n## Policy\n\n- be kind\n';
  const actions = parseRouteTableSource(
    `defineRoute({ name: 'ping', description: 'answers', method: 'GET', path: '/api/ping', params: z.object({}), errorStatus: {}, handler: () => null })`,
  );
  const regen = regenerateAgentsActions(text, 'x', actions);
  assert.equal(regen.appendedFresh, true);
  // before ## Policy, markers present once, ping inside
  assert.ok(regen.text.indexOf('## Actions') < regen.text.indexOf('## Policy'));
  assert.equal(regen.text.match(/<!-- BEGIN ACTIONS/g).length, 1);
  assert.match(regen.text, /### ping[\s\S]*?answers[\s\S]*?GET \/apps\/x\/api\/ping/);
  // with no ## Policy, the section appends at the end
  const tail = regenerateAgentsActions('# AGENTS.md\n', 'x', actions);
  assert.equal(tail.appendedFresh, true);
  assert.ok(tail.text.trimEnd().endsWith('<!-- END ACTIONS -->'));
});

// ---------- add_action ----------

test('add_action: the lockstep — every artifact written, in order, from one table entry', async () => {
  const { root, slug, tree } = await world('lockstep');
  const r = await addAction(
    { appsRoot: root },
    { slug, name: 'Create Note', summary: 'captures a note' },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const { data } = r;
  assert.equal(data.action, 'create-note'); // normalized
  assert.equal(data.method, 'POST'); // the default
  assert.deepEqual(
    data.written.map(w => w.file),
    [
      'src/lib/create-note.ts',
      'src/routes.ts',
      'tests/create-note.test.mjs',
      'src/islands/CreateNoteIsland.tsx',
      'src/pages/index.astro',
      'AGENTS.md',
    ],
  );
  assert.deepEqual(data.notes, []);
  assert.match(data.next.join(' | '), /check/);
  assert.match(data.next.join(' | '), /build/);
  assert.match(data.next.join(' | '), /reload/);

  // 1. the domain module: node-free, type-only imports
  const lib = fs.readFileSync(path.join(tree, 'src/lib/create-note.ts'), 'utf8');
  assert.match(lib, /export function createNoteResult\(rawText: string\)/);
  assert.match(lib, /ResultSuccess<'create-note', CreateNoteData>/);
  assert.match(lib, /import type \{ ResultFailure, ResultSuccess \} from '@cybermole\/app-kit';/);

  // 2. the table entry inside the array, import added
  const routes = fs.readFileSync(path.join(tree, 'src/routes.ts'), 'utf8');
  assert.match(routes, /import \{ createNoteResult \} from '\.\/lib\/create-note';/);
  assert.match(
    routes,
    /name: 'create-note',\n {4}description: 'captures a note',\n {4}method: 'POST',\n {4}path: '\/api\/create-note',/,
  );
  assert.ok(
    routes.indexOf(`handler: ({ body }) => createNoteResult(body.text),`) >
      routes.indexOf("name: 'ping'"),
  );

  // 3. the test stub, inside the tests/*.test.mjs glob
  const testStub = fs.readFileSync(path.join(tree, 'tests/create-note.test.mjs'), 'utf8');
  assert.match(testStub, /from '\.\.\/src\/lib\/create-note\.ts'/);
  const pkg = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/); // the glob picks it up, no script edit

  // 4. the island, and the page mounts inside the markers
  const island = fs.readFileSync(path.join(tree, 'src/islands/CreateNoteIsland.tsx'), 'utf8');
  // Bracket access: a kebab name isn't a valid identifier.
  assert.match(island, /client\['create-note'\]\(\{ params: \{\}, body: \{ text \} \}\)/);
  const page = fs.readFileSync(path.join(tree, 'src/pages/index.astro'), 'utf8');
  const mounts = page.match(/<!-- BEGIN ACTION MOUNTS[\s\S]*?<!-- END ACTION MOUNTS -->/)[0];
  assert.match(mounts, /ping-island[\s\S]*?create-note-island/); // appended after ping
  const islands = page.match(/\/\/ BEGIN ACTION ISLANDS[\s\S]*?\/\/ END ACTION ISLANDS/)[0];
  assert.match(islands, /mountIsland\('\.create-note-island', CreateNoteIsland, \{\}\);/);

  // 5. AGENTS.md regenerated with both actions
  const block = fs
    .readFileSync(path.join(tree, 'AGENTS.md'), 'utf8')
    .match(/<!-- BEGIN ACTIONS[\s\S]*?<!-- END ACTIONS -->/)[0];
  assert.match(block, /### ping[\s\S]*### create-note/);

  // the written table parses to exactly the two actions
  assert.deepEqual(
    parseRouteTableSource(routes).map(a => a.name),
    ['ping', 'create-note'],
  );
});

test('add_action: the GET parameterization — the input lands in the query', async () => {
  const { root, slug, tree } = await world('getvar');
  const r = await addAction(
    { appsRoot: root },
    { slug, name: 'lookup', summary: 'looks it up', method: 'GET' },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const routes = fs.readFileSync(path.join(tree, 'src/routes.ts'), 'utf8');
  assert.match(
    routes,
    /method: 'GET',\n {4}path: '\/api\/lookup',\n {4}params: z\.object\(\{\}\),\n {4}query: z\.object\(\{/,
  );
  assert.match(routes, /handler: \(\{ query \}\) => lookupResult\(query\.text\),/);
  const island = fs.readFileSync(path.join(tree, 'src/islands/LookupIsland.tsx'), 'utf8');
  assert.match(island, /client\['lookup'\]\(\{ params: \{\}, query: \{ text \} \}\)/);
});

test('add_action: the generated island compiles for every accepted name form — plain, kebab, snake', async () => {
  // Client methods are the route names verbatim; each island must use the
  // bracket form its name requires.
  const { root, slug, tree } = await world('names');
  for (const name of ['echo', 'create-note', 'note_create']) {
    const r = await addAction({ appsRoot: root }, { slug, name });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const camelToStem = { echo: 'Echo', 'create-note': 'CreateNote', note_create: 'NoteCreate' };
  for (const [name, stem] of Object.entries(camelToStem)) {
    const island = fs.readFileSync(path.join(tree, 'src', 'islands', `${stem}Island.tsx`), 'utf8');
    const expected = `client['${name}']({ params: {}, body: { text } })`;
    assert.ok(island.includes(expected), `${name}: bracket access with the literal name`);
    assert.ok(!island.includes(`client.${name}(`), `${name}: never dot access`);
  }
  // the table carries all three
  const routes = fs.readFileSync(path.join(tree, 'src', 'routes.ts'), 'utf8');
  assert.deepEqual(
    parseRouteTableSource(routes).map(a => a.name),
    ['ping', 'echo', 'create-note', 'note_create'],
  );
  // The tree's own typecheck passes over every generated island.
  const typecheck = await runChild('npm', ['run', 'typecheck'], { cwd: tree, timeoutMs: 120_000 });
  assert.equal(typecheck.code, 0, `${typecheck.stdout}\n${typecheck.stderr}`);
});

test('add_action: a summary with newlines, backslashes and quotes stays one escaped line — the table parses back', async () => {
  const { root, slug, tree } = await world('summary');
  const r = await addAction(
    { appsRoot: root },
    { slug, name: 'note', summary: "captures\na note\n\twith 'quotes' and \\ backslashes" },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const routes = fs.readFileSync(path.join(tree, 'src', 'routes.ts'), 'utf8');
  // the generated description is one complete single-quoted line
  const descLines = routes.split('\n').filter(l => l.includes("description: '"));
  assert.equal(descLines.length, 2); // ping + note
  for (const line of descLines) {
    assert.match(
      line.trim(),
      /^description: '((?:[^'\\\n]|\\.)*)',$/,
      'one complete, escaped single-quoted literal',
    );
  }
  // the parser reads it back collapsed
  const parsed = parseRouteTableSource(routes).find(a => a.name === 'note');
  assert.equal(parsed?.description, "captures a note with 'quotes' and \\ backslashes");
  // and the manual's section has the same line
  const block = fs
    .readFileSync(path.join(tree, 'AGENTS.md'), 'utf8')
    .match(/<!-- BEGIN ACTIONS[\s\S]*?<!-- END ACTIONS -->/)[0];
  assert.match(block, /### note\n\ncaptures a note with 'quotes' and \\ backslashes\n/);
});

test('add_action: idempotence — the same name is a clear action_exists, no file touched', async () => {
  const { root, slug, tree } = await world('dup');
  assert.equal((await addAction({ appsRoot: root }, { slug, name: 'note' })).ok, true);
  const before = ['src/routes.ts', 'AGENTS.md', 'src/pages/index.astro'].map(f =>
    fs.readFileSync(path.join(tree, f), 'utf8'),
  );
  const again = await addAction({ appsRoot: root }, { slug, name: 'Note!' }); // normalizes to the same name
  assert.equal(again.ok, false);
  assert.equal(again.errorCode, 'action_exists');
  assert.match(again.errorMessage, /already has a "note" action/);
  assert.match(again.errorMessage, /ping, note/); // names what is present
  const after = ['src/routes.ts', 'AGENTS.md', 'src/pages/index.astro'].map(f =>
    fs.readFileSync(path.join(tree, f), 'utf8'),
  );
  assert.deepEqual(after, before); // byte-identical — never a mangled file
});

test('add_action: tree_not_found, invalid_name, and the diverged-tree refusal', async () => {
  const { root, slug, tree } = await world('errors');
  const noTree = await addAction({ appsRoot: root }, { slug: 'absent-app', name: 'x' });
  assert.equal(noTree.errorCode, 'tree_not_found');
  const badName = await addAction({ appsRoot: root }, { slug, name: '!!!' });
  assert.equal(badName.errorCode, 'invalid_name');
  assert.match(badName.errorMessage, /kebab\/snake/);
  // an artifact without its table entry: diverged, refused
  fs.writeFileSync(path.join(tree, 'tests', 'ghost.test.mjs'), '// hand-written\n');
  const ghost = await addAction({ appsRoot: root }, { slug, name: 'ghost' });
  assert.equal(ghost.errorCode, 'artifact_exists');
  assert.match(ghost.errorMessage, /tests\/ghost\.test\.mjs/);
  assert.match(ghost.errorMessage, /never overwrites/);
  assert.ok(!fs.existsSync(path.join(tree, 'src/lib/ghost.ts'))); // nothing written
});

test('add_action: missing page/markers — fresh marked blocks appended, the answer says so', async () => {
  const { root, slug, tree } = await world('markers');
  const pagePath = path.join(tree, 'src/pages/index.astro');
  const agentsPath = path.join(tree, 'AGENTS.md');
  // a page that lost its markers…
  let page = fs.readFileSync(pagePath, 'utf8');
  page = page
    .replace(/<!-- BEGIN ACTION MOUNTS[^\n]*-->\n/, '')
    .replace(/<!-- END ACTION MOUNTS -->\n/, '')
    .replace(/\/\/ BEGIN ACTION ISLANDS[^\n]*\n/, '')
    .replace(/\/\/ END ACTION ISLANDS\n/, '');
  fs.writeFileSync(pagePath, page);
  // …and a manual that lost its block
  const agents = fs
    .readFileSync(agentsPath, 'utf8')
    .replace(/<!-- BEGIN ACTIONS[\s\S]*?<!-- END ACTIONS -->\n\n/, '');
  assert.ok(!agents.includes('BEGIN ACTIONS'));
  fs.writeFileSync(agentsPath, agents);

  const r = await addAction({ appsRoot: root }, { slug, name: 'note' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.notes.length, 3); // fresh mount block, fresh island block, fresh manual section
  assert.match(r.data.notes.join(' | '), /no ACTION MOUNTS markers/);
  assert.match(r.data.notes.join(' | '), /no ACTION ISLANDS markers/);
  assert.match(r.data.notes.join(' | '), /no BEGIN\/END ACTIONS markers/);
  const pageAfter = fs.readFileSync(pagePath, 'utf8');
  assert.match(
    pageAfter,
    /<!-- BEGIN ACTION MOUNTS[\s\S]*?note-island[\s\S]*?<!-- END ACTION MOUNTS -->/,
  );
  assert.match(pageAfter, /\/\/ BEGIN ACTION ISLANDS[\s\S]*?mountIsland\('\.note-island'/);
  const agentsAfter = fs.readFileSync(agentsPath, 'utf8');
  assert.match(
    agentsAfter,
    /<!-- BEGIN ACTIONS[\s\S]*### ping[\s\S]*### note[\s\S]*<!-- END ACTIONS -->/,
  );

  // the next action lands inside the fresh blocks, not a second one
  const r2 = await addAction({ appsRoot: root }, { slug, name: 'echo' });
  assert.equal(r2.ok, true);
  assert.equal(r2.data.notes.length, 0);
  const page2 = fs.readFileSync(pagePath, 'utf8');
  assert.equal(page2.match(/<!-- BEGIN ACTION MOUNTS/g).length, 1);
  assert.match(page2, /note-island[\s\S]*echo-island/);
});

// ---------- emitted table ----------

const emittedTable = [
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
];

function synthTreeWithTable(root, slug, table) {
  const tree = path.join(root, slug);
  fs.mkdirSync(path.join(tree, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'app.json'), JSON.stringify({ name: slug }));
  fs.writeFileSync(path.join(tree, 'dist', 'route-table.json'), JSON.stringify(table, null, 2));
  return tree;
}

test('readRouteTable: built / unbuilt / missing tree / malformed JSON', () => {
  const root = fs.mkdtempSync(path.join(dir, 'rt-'));
  synthTreeWithTable(root, 'built-app', emittedTable);
  const built = readRouteTable(path.join(root, 'built-app'));
  assert.equal(built.ok, true);
  assert.equal(built.table.length, 2);
  const unbuiltTree = path.join(root, 'unbuilt-app');
  fs.mkdirSync(unbuiltTree, { recursive: true });
  fs.writeFileSync(path.join(unbuiltTree, 'app.json'), '{}');
  const unbuilt = readRouteTable(unbuiltTree);
  assert.equal(unbuilt.ok, false);
  assert.equal(unbuilt.errorCode, 'not_built');
  assert.match(unbuilt.errorMessage, /build tool/);
  const missing = readRouteTable(path.join(root, 'never'));
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'tree_not_found');
  synthTreeWithTable(root, 'broken-app', emittedTable);
  fs.writeFileSync(path.join(root, 'broken-app', 'dist', 'route-table.json'), 'not-json');
  const bad = readRouteTable(path.join(root, 'broken-app'));
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, 'not_built');
  assert.match(bad.errorMessage, /not valid JSON/);
});

test("lenientPreflight: presence-only — required keys must exist; types and extras are the app's to judge", () => {
  const input = emittedTable[1].input;
  const check = params => lenientPreflight(input).safeParse(params);
  assert.equal(check({ id: 7, text: 'hi' }).success, true);
  assert.equal(check({ id: '7', text: 5, extra: true }).success, true); // lenient: types pass, extras pass
  const missing = check({ id: 7 });
  assert.equal(missing.success, false);
  assert.equal(missing.error.issues[0].path[0], 'text');
  assert.equal(check('not an object').success, false);
});

test('planActionRequest: THE request the entry names — path params interpolated, GET query, POST body', () => {
  const ping = findAction(emittedTable, 'ping');
  const get = planActionRequest('notes-app', ping, { name: 'a b&c' });
  assert.equal(get.ok, true);
  assert.deepEqual(get.request, {
    method: 'GET',
    pathname: '/apps/notes-app/api/ping',
    search: 'name=a+b%26c',
    body: undefined,
  });

  const note = findAction(emittedTable, 'note_create');
  const post = planActionRequest('notes-app', note, { id: 7, text: 'hi', tag: 'b' });
  assert.equal(post.ok, true);
  assert.deepEqual(post.request, {
    method: 'POST',
    pathname: '/apps/notes-app/api/notes/7',
    search: '',
    body: JSON.stringify({ text: 'hi', tag: 'b' }),
  });

  const bad = planActionRequest('notes-app', note, { text: 'no id' });
  assert.equal(bad.ok, false);
  assert.equal(bad.issues.id, 'id is required');
  const notObject = planActionRequest('notes-app', note, ['nope']);
  assert.equal(notObject.ok, false);
  assert.equal(notObject.issues[''], 'params must be an object');
});

test("shapeFromJsonSchema: the shim's tool schema — typed as far as the emitted subset goes, coercive scalars", () => {
  const shape = shapeFromJsonSchema(emittedTable[1].input);
  assert.deepEqual(Object.keys(shape), ['id', 'text', 'tag']);
  assert.equal(shape.id.safeParse('7').success, true); // string spelling passes (the app coerces)
  assert.equal(shape.id.safeParse('abc').success, false);
  assert.equal(shape.id.safeParse(0).success, false); // minimum: 1
  assert.equal(shape.text.safeParse(500).success, false); // a string field stays a string
  assert.equal(shape.tag.safeParse('a').success, true);
  assert.equal(shape.tag.safeParse('z').success, false);
  const ping = shapeFromJsonSchema(emittedTable[0].input);
  assert.equal(ping.name.safeParse('x').success, true);
  assert.equal(ping.name.safeParse('x'.repeat(65)).success, false); // maxLength rides
  // unknown constructs stay permissive; optional fields accept absence
  const weird = shapeFromJsonSchema({
    type: 'object',
    properties: { when: { type: 'string', format: 'date-time' }, flag: { type: 'boolean' } },
    required: ['when'],
  });
  assert.equal(weird.when.safeParse({}).success, false);
  assert.equal(weird.when.safeParse('whenever').success, true); // format is not judged
  assert.equal(weird.flag.safeParse(undefined).success, true); // absent = optional
  const withFlag = shapeFromJsonSchema({
    type: 'object',
    properties: { flag: { type: 'boolean' } },
    required: ['flag'],
  });
  assert.equal(withFlag.flag.safeParse('false').success, true); // 'false' passes…
  assert.equal(withFlag.flag.safeParse('false').data, false); // …and normalizes
});

// ---------- describe / call ----------

/** Records every request, answers canned JSON. */
function stubHost(socketPath, answerFor) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => {
      body += c;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      const canned = answerFor(req);
      res.writeHead(canned.status, { 'Content-Type': 'application/json' });
      res.end(typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body));
    });
  });
  return new Promise(resolve => {
    server.listen(socketPath, () => resolve({ server, seen }));
  });
}

test('describeTool: the emitted table VERBATIM; unbuilt is a domain answer naming build', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'describe-'));
  synthTreeWithTable(root, 'built-app', emittedTable);
  const deps = {
    appsRoot: root,
    internalSocketPath: null,
    appsSocketPath: null,
    installRoot: REPO,
  };
  const built = await describeTool(deps, 'built-app');
  const parsed = JSON.parse(built.content[0].text);
  assert.deepEqual(parsed, emittedTable);
  assert.equal(built.isError, undefined);
  const unbuilt = await describeTool(deps, 'absent-app');
  assert.equal(unbuilt.isError, undefined); // a domain answer, never isError
  const domain = JSON.parse(unbuilt.content[0].text);
  assert.equal(domain.ok, false);
  assert.equal(domain.errorCode, 'tree_not_found');
  fs.mkdirSync(path.join(root, 'unbuilt-app'), { recursive: true });
  const notBuilt = JSON.parse((await describeTool(deps, 'unbuilt-app')).content[0].text);
  assert.equal(notBuilt.errorCode, 'not_built');
  assert.match(notBuilt.errorMessage, /build/);
});

test("callActionTool: THE request against the apps socket, the app's Result JSON verbatim; domain answers; transport-only isError", async () => {
  const root = fs.mkdtempSync(path.join(dir, 'call-'));
  synthTreeWithTable(root, 'notes-app', emittedTable);
  const socketPath = path.join(root, 'apps.sock');
  const { server, seen } = await stubHost(socketPath, req => {
    if (req.url === '/apps/notes-app/api/notes/7')
      return { status: 201, body: { ok: true, resultType: 'note_create', data: { id: 7 } } };
    if (req.url === '/apps/notes-app/api/ping?name=root')
      return {
        status: 200,
        body: { ok: false, resultType: 'ping', errorCode: 'invalid_name', errorMessage: 'no' },
      };
    return {
      status: 404,
      body: { ok: false, resultType: 'route_api', errorCode: 'route_not_found' },
    };
  });
  const deps = {
    appsRoot: root,
    internalSocketPath: null,
    appsSocketPath: socketPath,
    installRoot: REPO,
  };

  // POST with a path param and body: the request the entry names
  const post = await callActionTool(deps, {
    slug: 'notes-app',
    action: 'note_create',
    params: { id: 7, text: 'hi' },
  });
  assert.equal(post.isError, undefined);
  assert.deepEqual(JSON.parse(post.content[0].text), {
    ok: true,
    resultType: 'note_create',
    data: { id: 7 },
  });
  assert.deepEqual(seen.at(-1), {
    method: 'POST',
    url: '/apps/notes-app/api/notes/7',
    body: JSON.stringify({ text: 'hi' }),
  });

  // GET with a query; the app's failure JSON is a normal result too
  const fail = await callActionTool(deps, {
    slug: 'notes-app',
    action: 'ping',
    params: { name: 'root' },
  });
  assert.equal(fail.isError, undefined);
  assert.deepEqual(JSON.parse(fail.content[0].text), {
    ok: false,
    resultType: 'ping',
    errorCode: 'invalid_name',
    errorMessage: 'no',
  });

  // domain answers: unknown action, invalid params (app not called)
  const seenBefore = seen.length;
  const unknown = JSON.parse(
    (await callActionTool(deps, { slug: 'notes-app', action: 'nope' })).content[0].text,
  );
  assert.equal(unknown.errorCode, 'action_not_found');
  assert.match(unknown.errorMessage, /ping, note_create/);
  const invalid = JSON.parse(
    (
      await callActionTool(deps, {
        slug: 'notes-app',
        action: 'note_create',
        params: { text: 'x' },
      })
    ).content[0].text,
  );
  assert.equal(invalid.errorCode, 'invalid_params');
  assert.equal(invalid.issues.id, 'id is required');
  assert.equal(seen.length, seenBefore); // never sent

  // isError only for transport: surface off, host gone
  const off = await callActionTool(
    { ...deps, appsSocketPath: null },
    { slug: 'notes-app', action: 'ping', params: { name: 'x' } },
  );
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /CYBERMOLE_APPS_SOCK is empty/);
  const gone = await callActionTool(
    { ...deps, appsSocketPath: path.join(root, 'dead.sock') },
    { slug: 'notes-app', action: 'ping', params: { name: 'x' } },
  );
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /could not reach the app host/);

  await new Promise(resolve => server.close(resolve));
});
