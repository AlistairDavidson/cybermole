// apps-mcp.test.mjs — task/app-scaffold (docs/apps-plan.md §6/§10) units:
// the cybermole-apps MCP's three halves.
//   scaffold (src/lib/apps-scaffold.ts): REAL tree-writing against a tmp
//     apps root — template copy with slug/base/name baking, the composed
//     app.json, the .pi/mcp.json role boundary (cybermole-apps disabled +
//     the inert shim entry), the per-package node_modules links (the
//     template's own script, run for real), git init + the first commit,
//     and every error code of the family.
//   the gate (src/lib/apps-gate.ts): the quiet-envelope mapping over an
//     INJECTED runner — all-green, a failing stage (output tail + counts),
//     a timeout, the links precheck (a bad install dies first, with the
//     fix named), tree_not_found, run_failed — plus the TAP count parser.
//   status (src/lib/apps-status.ts): the join — rows × host answer ×
//     synthetic trees (fresh/stale/unbuilt/absent), the host's skip
//     reasons, the booting case, unregistered trees, non-tree dirs
//     ignored.
// The MCP's own tool WIRING gets one real child over stdio (the mcp.test
// mcp shape, one boot): the tool list is exactly this branch's set
// (add_action/describe/call are branch 5, absent), a status call answers
// through both stub sockets, and an empty CYBERMOLE_APPS_SOCK turns
// reload into the clear off-surface isError.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-apps-mcp-'));

const { scaffoldApp } = await import('../../dist-server/src/lib/apps-scaffold.js');
const { CommandNotFoundError } = await import('../../dist-server/src/lib/apps-child.js');
const { checkApp, buildApp } = await import('../../dist-server/src/lib/apps-gate.js');
const { joinAppsStatus, inspectTree, collectTrees } =
  await import('../../dist-server/src/lib/apps-status.js');
const { registerPrecheck } = await import('../../dist-server/server/apps-mcp.js');
const { appsRootDefault } = await import('../../dist-server/src/lib/env.js');
const { runChild } = await import('../../dist-server/src/lib/apps-child.js');

const scaffoldDeps = root => ({
  appsRoot: root,
  templateDir: path.join(REPO, 'app-starter'),
  agentTemplateFile: path.join(REPO, 'apps-agent-template', 'AGENTS.md'),
  installRoot: REPO,
  run: runChild,
});

// ---------- scaffold: the tree, written for real ----------

test('scaffold: writes the baked tree, links node_modules, commits — the happy path', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const r = await scaffoldApp(scaffoldDeps(root), {
    name: 'Smoke Probe 2',
    description: 'the unit-run tree',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { slug, tree } = r.data;
  assert.equal(slug, 'smoke-probe-2');
  assert.equal(r.data.linked, true);
  assert.equal(r.data.committed, true);
  // the manifest is COMPOSED (null description handling lives here, not
  // in a marker): name/description/slug all present.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tree, 'app.json'), 'utf8')), {
    name: 'Smoke Probe 2',
    description: 'the unit-run tree',
    slug,
  });
  // the base is baked into the astro config, the slug everywhere else.
  const astro = fs.readFileSync(path.join(tree, 'astro.config.mjs'), 'utf8');
  assert.ok(astro.includes(`const base = '/apps/${slug}'`), 'base baked');
  assert.ok(!astro.includes('__APP_SLUG__'), 'no leftover marker');
  // the role boundary (§6): cybermole-apps DISABLED (project-overrides-
  // user) and the app's own shim entry under the slug — pointing at the
  // install's dist-server, inert until branch 5 ships the binary.
  const mcpJson = JSON.parse(fs.readFileSync(path.join(tree, '.pi', 'mcp.json'), 'utf8'));
  assert.deepEqual(mcpJson.mcpServers['cybermole-apps'], { enabled: false });
  assert.deepEqual(mcpJson.mcpServers[slug].args, [
    path.join(REPO, 'dist-server', 'server', 'app-mcp-shim.js'),
    slug,
  ]);
  // the operator manual is seeded with the app's identity and the
  // example action's section (branch 5's add_action regenerates it).
  const agents = fs.readFileSync(path.join(tree, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('Smoke Probe 2') && agents.includes(slug));
  assert.ok(agents.includes('### ping') && agents.includes('BEGIN ACTIONS'));
  // the per-package links: the core stack resolves, the bins too.
  for (const name of ['astro', 'zod', '@cybermole/app-kit', 'parse5']) {
    assert.ok(
      fs.lstatSync(path.join(tree, 'node_modules', ...name.split('/'))).isSymbolicLink(),
      `${name} linked`,
    );
  }
  assert.ok(fs.lstatSync(path.join(tree, 'node_modules', '.bin', 'astro')).isSymbolicLink());
  // the install root is baked for re-runs after image upgrades.
  const setup = fs.readFileSync(path.join(tree, 'scripts', 'setup-node-modules.mjs'), 'utf8');
  assert.ok(setup.includes(`'${REPO}'`), 'install root baked');
  // git: a real repo whose first commit IS the scaffold; data/ tracked
  // only as .gitkeep.
  assert.ok(fs.existsSync(path.join(tree, '.git')));
  const log = await runChild('git', ['log', '--oneline'], { cwd: tree });
  assert.equal(log.code, 0, log.stderr);
  assert.match(log.stdout, /scaffold smoke-probe-2/);
  assert.ok(fs.existsSync(path.join(tree, 'data', '.gitkeep')));
});

test('scaffold: an absent description becomes null in app.json', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const r = await scaffoldApp(scaffoldDeps(root), { name: 'quiet one' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.data.tree, 'app.json'), 'utf8')), {
    name: 'quiet one',
    description: null,
    slug: 'quiet-one',
  });
});

test('scaffold: invalid_name — a name with nothing slug-able', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const r = await scaffoldApp(scaffoldDeps(root), { name: '!!!' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'invalid_name');
  assert.equal(fs.readdirSync(root).length, 0, 'nothing written');
});

test('scaffold: tree_exists — never overwrites, the message says so', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const first = await scaffoldApp(scaffoldDeps(root), { name: 'twin' });
  assert.equal(first.ok, true);
  const again = await scaffoldApp(scaffoldDeps(root), { name: 'Twin!' });
  assert.equal(again.ok, false);
  assert.equal(again.errorCode, 'tree_exists');
  assert.match(again.errorMessage, /never overwrites/);
});

test('scaffold: template_missing — a broken install fails before writing', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const r = await scaffoldApp(
    { ...scaffoldDeps(root), templateDir: '/no/such/dir' },
    { name: 'x' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'template_missing');
  assert.equal(fs.readdirSync(root).length, 0, 'nothing written');
});

test('scaffold: git_missing — the tree and links stand, the message says what to run', async () => {
  const root = fs.mkdtempSync(path.join(dir, 'case-'));
  const noGit = (command, args, options) => {
    if (command === 'git') return Promise.reject(new CommandNotFoundError('git'));
    return runChild(command, args, options);
  };
  const r = await scaffoldApp({ ...scaffoldDeps(root), run: noGit }, { name: 'no git' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'git_missing');
  assert.equal(r.data.linked, true);
  assert.match(r.errorMessage, /git init/);
  assert.ok(!fs.existsSync(path.join(r.data.tree, '.git')));
});

// ---------- the gate: envelope mapping over an injected runner ----------

/** A scripted runner: keyed by the npm script name (the label under
 *  test), returning canned ChildRuns; unmatched commands run for real. */
const fakeRunner = scriptRuns => (command, args) => {
  if (command !== 'npm') return runChild(command, args);
  const script = args[1];
  const canned = scriptRuns[script];
  if (canned === undefined) throw new Error(`unexpected script ${script}`);
  return Promise.resolve({
    code: canned.code ?? 0,
    stdout: canned.stdout ?? '',
    stderr: canned.stderr ?? '',
    timedOut: canned.timedOut ?? false,
    durationS: 0.1,
  });
};

const gateWorld = async () => {
  const root = fs.mkdtempSync(path.join(dir, 'gate-'));
  const tree = path.join(root, 'gate-app');
  fs.mkdirSync(tree);
  // a minimal real tree: the links check reads package.json's deps.
  fs.writeFileSync(
    path.join(tree, 'package.json'),
    JSON.stringify({
      name: 'gate-app',
      scripts: { typecheck: 'true', test: 'true', build: 'true' },
      dependencies: { astro: '*', zod: '*' },
    }),
  );
  for (const name of ['astro', 'zod']) {
    const p = path.join(tree, 'node_modules', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
  }
  fs.mkdirSync(path.join(tree, 'node_modules', '.bin'));
  fs.writeFileSync(path.join(tree, 'node_modules', '.bin', 'astro'), '');
  fs.writeFileSync(path.join(tree, 'node_modules', '.bin', 'tsc'), '');
  return { root, tree };
};

test('check: all green — one envelope, stage counts, test counts from the TAP footer', async () => {
  const { root } = await gateWorld();
  const r = await checkApp(
    {
      appsRoot: root,
      run: fakeRunner({
        typecheck: {},
        test: { stdout: '1..3\nok 1\nok 2\nok 3\n# tests 3\n# pass 3\n# fail 0\n# skipped 0\n' },
        build: {},
      }),
    },
    'gate-app',
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = r.data.envelope;
  assert.equal(e.passed, true);
  assert.equal(e.timed_out, false);
  assert.equal(e.returncode, 0);
  assert.deepEqual(e.counts, {
    stages: { total: 4, passed: 4, failed: 0 },
    tests: { pass: 3, fail: 0, skipped: 0 },
  });
  assert.equal(e.failures, undefined);
  assert.match(e.output, /all green/);
});

test('check: a failing test stage — red envelope, the stage named, the output tail carried', async () => {
  const { root } = await gateWorld();
  const r = await checkApp(
    {
      appsRoot: root,
      run: fakeRunner({
        typecheck: {},
        test: {
          code: 1,
          stdout:
            'not ok 1 - ping: a name answers hello\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n',
          stderr: 'some stderr detail',
        },
      }),
    },
    'gate-app',
  );
  assert.equal(r.ok, true);
  const e = r.data.envelope;
  assert.equal(e.passed, false);
  assert.equal(e.returncode, 1);
  assert.deepEqual(e.failures, [
    {
      stage: 'unit tests',
      error:
        'not ok 1 - ping: a name answers hello\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\nsome stderr detail',
    },
  ]);
  assert.deepEqual(e.counts.tests, { pass: 0, fail: 1, skipped: 0 });
  assert.deepEqual(e.counts.stages, { total: 4, passed: 2, failed: 1 });
  // first failure stops: build never ran.
  assert.equal(e.counts.stages.passed + e.counts.stages.failed, 3);
});

test('check: a timed-out stage says so, not a code', async () => {
  const { root } = await gateWorld();
  const r = await checkApp(
    { appsRoot: root, run: fakeRunner({ typecheck: { timedOut: true, code: null } }) },
    'gate-app',
  );
  const e = r.data.envelope;
  assert.equal(e.passed, false);
  assert.equal(e.timed_out, true);
  assert.match(e.failures[0].error, /timed out/);
});

test('check: the links precheck fails first, with the fix named, before any stage runs', async () => {
  const { root, tree } = await gateWorld();
  fs.rmSync(path.join(tree, 'node_modules', 'zod'));
  let ran = false;
  const r = await checkApp(
    {
      appsRoot: root,
      run: (command, args, options) => {
        ran = true;
        return runChild(command, args, options);
      },
    },
    'gate-app',
  );
  assert.equal(r.ok, true);
  const e = r.data.envelope;
  assert.equal(e.passed, false);
  assert.equal(ran, false, 'no stage ran');
  assert.deepEqual(e.counts.stages, { total: 4, passed: 0, failed: 1 });
  assert.match(e.failures[0].error, /zod missing/);
  assert.match(e.failures[0].error, /npm run setup/);
});

test('check and build: tree_not_found names the tree', async () => {
  const { root } = await gateWorld();
  for (const fn of [checkApp, buildApp]) {
    const r = await fn({ appsRoot: root, run: fakeRunner({}) }, 'never-there');
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'tree_not_found');
    assert.match(r.errorMessage, /never-there/);
  }
});

test("build: one stage, the build script — check's build half alone", async () => {
  const { root } = await gateWorld();
  const r = await buildApp(
    { appsRoot: root, run: fakeRunner({ build: { code: 1, stderr: 'gate failed' } }) },
    'gate-app',
  );
  const e = r.data.envelope;
  assert.equal(e.passed, false);
  assert.deepEqual(e.counts.stages, { total: 2, passed: 1, failed: 1 });
  assert.equal(e.failures[0].stage, 'astro build + route-table + self-containment');
});

test('check: run_failed — npm itself missing is a family failure, not an envelope', async () => {
  const { root } = await gateWorld();
  const r = await checkApp(
    {
      appsRoot: root,
      run: (command, args) =>
        args[1] === 'typecheck'
          ? Promise.reject(new CommandNotFoundError('npm'))
          : runChild(command, args),
    },
    'gate-app',
  );
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'run_failed');
  assert.match(r.errorMessage, /npm is not on PATH/);
});

// ---------- status: the join ----------

/** A synthetic tree: manifest + (optionally) a build, with controllable
 *  source/build mtimes. */
function synthTree(root, slug, { build = true, touchSrcAfterBuild = false, manifest = true } = {}) {
  const tree = path.join(root, slug);
  fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
  if (manifest) {
    fs.writeFileSync(path.join(tree, 'app.json'), JSON.stringify({ name: `App ${slug}` }));
  }
  fs.writeFileSync(path.join(tree, 'src', 'page.astro'), 'x');
  fs.writeFileSync(path.join(tree, 'astro.config.mjs'), 'x');
  fs.writeFileSync(path.join(tree, 'package.json'), '{}');
  if (build) {
    fs.mkdirSync(path.join(tree, 'dist', 'server'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'dist', 'server', 'entry.mjs'), 'x');
    fs.writeFileSync(path.join(tree, 'dist', 'route-table.json'), '[]');
    const stamp = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(tree, 'dist', 'server', 'entry.mjs'), stamp, stamp);
    fs.utimesSync(path.join(tree, 'dist', 'route-table.json'), stamp, stamp);
    fs.utimesSync(path.join(tree, 'src'), stamp, stamp); // dirs count: a new file IS a change
    fs.utimesSync(path.join(tree, 'src', 'page.astro'), stamp, stamp);
    fs.utimesSync(path.join(tree, 'astro.config.mjs'), stamp, stamp);
    fs.utimesSync(path.join(tree, 'package.json'), stamp, stamp);
    if (touchSrcAfterBuild) {
      const later = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(tree, 'src', 'page.astro'), later, later);
    }
  }
  return tree;
}

test('status: the join — registered × mounted × built/stale × unregistered trees', () => {
  const root = fs.mkdtempSync(path.join(dir, 'join-'));
  const treeA = synthTree(root, 'app-a'); // registered + mounted + fresh build
  synthTree(root, 'app-b', { build: false }); // tree only, never built
  synthTree(root, 'app-c', { touchSrcAfterBuild: true }); // tree only, stale build
  fs.mkdirSync(path.join(root, 'not-an-app')); // no manifest → invisible
  const data = joinAppsStatus(
    root,
    [
      { id: '1', name: 'App app-a', slug: 'app-a', cwd: treeA },
      { id: '2', name: 'Group Row', slug: 'group-row', cwd: null },
    ],
    {
      booted: true,
      mounted: [{ slug: 'app-a' }],
      skipped: [
        { slug: 'group-row', reason: 'row has no cwd (a console group row, not an app tree)' },
      ],
    },
  );
  assert.equal(data.appsRoot, root);
  const bySlug = Object.fromEntries(data.apps.map(a => [a.slug, a]));
  assert.deepEqual(bySlug['app-a'], {
    slug: 'app-a',
    name: 'App app-a',
    registered: true,
    tree: treeA,
    hasManifest: true,
    built: true,
    buildStale: false,
    mounted: true,
    servingReason: null,
  });
  assert.equal(bySlug['app-b'].registered, false);
  assert.equal(bySlug['app-b'].built, false);
  assert.equal(bySlug['app-b'].buildStale, null);
  assert.equal(bySlug['app-b'].mounted, false);
  assert.match(bySlug['app-b'].servingReason, /not registered/);
  assert.equal(bySlug['app-c'].built, true);
  assert.equal(bySlug['app-c'].buildStale, true, 'src newer than the build → stale');
  assert.equal(bySlug['group-row'].tree, null);
  assert.equal(bySlug['group-row'].hasManifest, false);
  assert.equal(
    bySlug['group-row'].servingReason,
    'row has no cwd (a console group row, not an app tree)',
  );
  assert.ok(!('not-an-app' in bySlug), 'a dir without a manifest is not an app tree');
  assert.deepEqual(data.unregisteredTrees, ['app-b', 'app-c']);
});

test('status: registered but not mounted, host still booting — the reason says so', () => {
  const root = fs.mkdtempSync(path.join(dir, 'join-'));
  const treeA = synthTree(root, 'app-a');
  const data = joinAppsStatus(root, [{ id: '1', name: 'a', slug: 'app-a', cwd: treeA }], {
    booted: false,
    mounted: [],
    skipped: [],
  });
  assert.equal(data.apps[0].mounted, false);
  assert.match(data.apps[0].servingReason, /first discovery/);
});

test('status: a row whose cwd points OUTSIDE the apps root still reports its tree', () => {
  const root = fs.mkdtempSync(path.join(dir, 'join-'));
  const elsewhere = fs.mkdtempSync(path.join(dir, 'elsewhere-'));
  const tree = synthTree(elsewhere, 'moved-app');
  const data = joinAppsStatus(root, [{ id: '1', name: 'm', slug: 'moved-app', cwd: tree }], {
    booted: true,
    mounted: [],
    skipped: [],
  });
  assert.equal(data.apps[0].tree, tree);
  assert.equal(data.apps[0].built, true);
  assert.match(data.apps[0].servingReason, /not mounted/);
});

test('status: a missing route-table.json makes the build stale (both artifacts must postdate)', () => {
  const root = fs.mkdtempSync(path.join(dir, 'join-'));
  const tree = synthTree(root, 'app-a');
  fs.rmSync(path.join(tree, 'dist', 'route-table.json'));
  assert.equal(inspectTree(tree).buildStale, true);
});

test('status: collectTrees ignores dot dirs and non-dirs', () => {
  const root = fs.mkdtempSync(path.join(dir, 'join-'));
  synthTree(root, 'app-a');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, '.hidden', 'app.json'), '{}');
  fs.writeFileSync(path.join(root, 'loose-file'), '');
  assert.deepEqual([...collectTrees(root).keys()], ['app-a']);
});

// ---------- the env default ----------

test('appsRootDefault: the workspace volume owns the default; the state dir is the fallback', () => {
  assert.equal(appsRootDefault('/state', true), '/workspace/apps');
  assert.equal(appsRootDefault('/state', false), path.join('/state', 'apps'));
});

// ---------- register's local precheck ----------

test("registerPrecheck: the manifest's name is the registration's name; failures name the tree", async () => {
  const root = fs.mkdtempSync(path.join(dir, 'reg-'));
  const r = await scaffoldApp(scaffoldDeps(root), { name: 'pre check' });
  const ok = registerPrecheck(root, 'pre-check');
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'pre check');
  assert.equal(ok.tree, r.data.tree);
  const noTree = registerPrecheck(root, 'absent');
  assert.equal(noTree.ok, false);
  assert.equal(noTree.failure.errorCode, 'tree_not_found');
  fs.mkdirSync(path.join(root, 'bad-manifest'));
  fs.writeFileSync(path.join(root, 'bad-manifest', 'app.json'), JSON.stringify({ name: 7 }));
  const badCheck = registerPrecheck(root, 'bad-manifest');
  assert.equal(badCheck.ok, false);
  assert.equal(badCheck.failure.errorCode, 'manifest_invalid');
});

// ---------- the MCP wiring: one real child over stdio ----------

/** A tiny stub socket server answering canned JSON per path — the host
 *  stand-in the join reads. */
function stubSocket(socketPath, answers) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const key = `${req.method} ${(req.url ?? '').split('?')[0]}`;
      const canned = answers[key] ?? { status: 404, body: { error: 'not found' } };
      res.writeHead(canned.status, { 'Content-Type': 'application/json' });
      res.end(typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body));
    });
    server.listen(socketPath, () => resolve(server));
  });
}
test("the MCP wiring: tools/list is exactly this branch's set; status answers the join; reload off-surface is isError", async () => {
  const root = fs.mkdtempSync(path.join(dir, 'wire-'));
  const appsRoot = path.join(root, 'apps');
  const internalSocket = path.join(root, 'internal.sock');
  const hostSocket = path.join(root, 'apps.sock');
  synthTree(appsRoot, 'wired-app');
  const internal = await stubSocket(internalSocket, {
    'GET /apps': { status: 200, body: { apps: [] } },
    'POST /apps': {
      status: 409,
      body: {
        error: 'an app with the slug "wired-app" already exists',
        detail: null,
        code: 'duplicate_slug',
      },
    },
    'DELETE /apps/wired-app': { status: 200, body: { id: 'x' } },
  });
  const host = await stubSocket(hostSocket, {
    'GET /_admin/status': {
      status: 200,
      body: { booted: true, mounted: [], skipped: [] },
    },
  });
  const boot = async extraEnv => {
    const client = new Client({ name: 'apps-mcp-unit', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(REPO, 'dist-server', 'server', 'apps-mcp.js')],
        env: {
          CYBERMOLE_APPS_ROOT: appsRoot,
          CYBERMOLE_SOCK: internalSocket,
          CYBERMOLE_APPS_SOCK: hostSocket,
          ...extraEnv,
        },
      }),
    );
    return client;
  };
  const call = async (client, name, args) => {
    const r = await client.callTool({ name, arguments: args ?? {} });
    return { isError: r.isError === true, text: r.content.map(c => c.text ?? '').join('') };
  };

  // Boot one: the full surface — the tool list + a real status join.
  const client = await boot();
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(t => t.name).sort(),
    ['build', 'check', 'register', 'reload', 'scaffold', 'status', 'unregister'],
    "exactly this branch's set — add_action/describe/call are branch 5",
  );
  const status = await call(client, 'status', {});
  assert.equal(status.isError, false);
  const parsed = JSON.parse(status.text);
  assert.equal(parsed.appsRoot, appsRoot);
  assert.deepEqual(parsed.unregisteredTrees, ['wired-app']);
  assert.notEqual(parsed.apps[0].servingReason, null);
  const missing = await call(client, 'status', { slug: 'no-such-app' });
  assert.equal(missing.isError, false);
  assert.deepEqual(JSON.parse(missing.text).apps, []);
  // register: a tree-less slug fails the LOCAL precheck (tree_not_found,
  // a normal result); a duplicate_slug ANSWER grows the recovery text —
  // the one deliberate deviation from verbatim (§6).
  const noTree = await call(client, 'register', { slug: 'no-such-app' });
  assert.equal(noTree.isError, false);
  assert.equal(JSON.parse(noTree.text).errorCode, 'tree_not_found');
  const dup = await call(client, 'register', { slug: 'wired-app' });
  assert.equal(dup.isError, false);
  const dupBody = JSON.parse(dup.text);
  assert.equal(dupBody.code, 'duplicate_slug');
  assert.match(dupBody.error, /recovery/);
  assert.match(dupBody.error, /no tree\s+i?s? touched/);
  await client.close();

  // Boot two: the apps surface OFF (empty socket env) — reload answers
  // the clear off-surface error as isError; unregister COMPOSES instead
  // (the row deletion is the whole story: no host, no mount); check
  // still works (local).
  const off = await boot({ CYBERMOLE_APPS_SOCK: '' });
  const reload = await call(off, 'reload', {});
  assert.equal(reload.isError, true);
  assert.match(reload.text, /CYBERMOLE_APPS_SOCK is empty/);
  const dropped = await call(off, 'unregister', { slug: 'wired-app' });
  assert.equal(dropped.isError, false, dropped.text);
  const droppedBody = JSON.parse(dropped.text);
  assert.deepEqual(droppedBody.unregister, { id: 'x' });
  assert.equal(droppedBody.reload, null);
  assert.match(droppedBody.note, /apps surface is off/);
  // check is LOCAL: the surface being off does not stop it — this stub
  // tree has no node_modules, so the LINKS stage fails (a red envelope is
  // a normal answer, the family's ok is true).
  const check = await call(off, 'check', { slug: 'wired-app' });
  assert.equal(check.isError, false);
  const checkBody = JSON.parse(check.text);
  assert.equal(checkBody.ok, true);
  assert.equal(checkBody.data.envelope.passed, false);
  assert.equal(checkBody.data.envelope.failures[0].stage, 'links');
  await off.close();
  await new Promise(resolve => internal.close(resolve));
  await new Promise(resolve => host.close(resolve));
});
