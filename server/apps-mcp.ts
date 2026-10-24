// apps-mcp.ts — the apps MCP server `cybermole-apps` (task/app-scaffold,
// docs/apps-plan.md §6): the ROOT agent's build-loop surface — scaffold,
// check, build, reload, register, unregister, status — plus the action
// vocabulary (task/app-actions): add_action (the generator — one table
// entry becomes route + MCP tool + UI stub + test stub + the AGENTS.md
// action section, in lockstep) and describe/call (the emitted table's
// read face and the root agent's use path; the app's own per-tree MCP
// is the shim, server/app-mcp-shim.ts). Everything the tools do is the
// plan's loop (§1): scaffold a starter → check green → register (the db
// row; the tree existed since scaffold) → reload (the host's sync
// point) → serve; the same reload after unregister drops the mount;
// add_action extends a tree between check and reload.
//
// Result vocabulary, the jobs MCP's rule (server/mcp.ts): socket-backed
// tools (reload/register/unregister/status) carry the APIs' wire JSON
// VERBATIM — an API failure is a normal tool result the model must read;
// the only isError results are TRANSPORT failures (a socket unreachable,
// the apps surface off — no answer at all, never a domain code). The
// local tools (scaffold/check/build) answer their own Result families /
// one quiet envelope (the cybermole-dev contract: {passed, returncode,
// duration_s, quiet, timed_out, output, counts?, failures?}) — a red
// envelope is information, not isError.
//
// stdout is the protocol channel: this process logs NOTHING (no logger —
// componentLogger's winston console transport writes to stdout and would
// corrupt the stream); boot-time diagnostics go to stderr.
//
// Importable standalone (units, the e2e loop driving the tools
// in-process) and runnable as an entry: `node
// dist-server/server/apps-mcp.js` — the pi template's mcp.json registers
// exactly that, user-level next to cybermole-jobs so every root-agent
// session gets it; an app tree's own .pi/mcp.json disables it (the
// scaffold writes that — operators don't scaffold, §6's role boundary).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppSlugSchema } from '@cybermole/app-kit';
import { APP_ROOT, readAppsRoot, readAppsSocket, readInternalApiSocket } from '../src/lib/env';
import { runChild } from '../src/lib/apps-child';
import { scaffoldApp } from '../src/lib/apps-scaffold';
import { buildApp, checkApp } from '../src/lib/apps-gate';
import { ActionNameSchema, addAction } from '../src/lib/apps-actions';
import { findAction, planActionRequest, readRouteTable } from '../src/lib/apps-route-table';
import { joinAppsStatus, type StatusAppRow, type StatusHostAnswer } from '../src/lib/apps-status';
import { requestInternalApi, type InternalApiAnswer } from '../src/lib/internal-api-client';

// ---------- shared plumbing ----------

const json = (body: unknown): CallToolResult => ({
  content: [
    { type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) },
  ],
});

const transportError = (why: string): CallToolResult => ({
  content: [{ type: 'text', text: why }],
  isError: true,
});

/** One socket call: either the answer (status + parsed-or-raw body) or
 *  the transport's isError result. A 4xx/5xx body is the API's own
 *  failure JSON — the CALLER returns it verbatim, never as isError. */
type SocketFetch =
  { ok: true; status: number; body: string } | { ok: false; result: CallToolResult };

async function fetchSocket(
  socketPath: string | null,
  offWhy: string,
  call: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    path: string;
    body?: string;
  },
  reachWhy: (socketPath: string, code: string | undefined, message: string) => string,
  timeoutMs = 10_000,
): Promise<SocketFetch> {
  if (socketPath === null) return { ok: false, result: transportError(offWhy) };
  let answer: InternalApiAnswer;
  try {
    answer = await requestInternalApi(socketPath, call, { timeoutMs });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, result: transportError(reachWhy(socketPath, e.code, e.message)) };
  }
  return { ok: true, status: answer.status, body: answer.body };
}

function parseOrRaw(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const APPS_OFF =
  'the apps surface is off (CYBERMOLE_APPS_SOCK is empty on this cybermole instance) ' +
  '— the app host is not listening; this tool cannot work until the operator turns ' +
  'the socket on';
const INTERNAL_OFF =
  'the internal API is disabled (CYBERMOLE_SOCK is empty on this cybermole instance) ' +
  '— the app verbs cannot work until the operator turns the socket on';

const unreachable = (sock: string, code: string | undefined, message: string): string =>
  `could not reach ${sock} ${code ? `(${code})` : `: ${message}`} ` +
  '— is the cybermole server (and the app host) running, and do they serve this socket?';

export interface AppsMcpDeps {
  /** env.ts readAppsRoot — where scaffold writes trees */
  appsRoot: string;
  /** env.ts readInternalApiSocket — register/unregister + status rows
   *  (null = the listener off → the clear disabled error). */
  internalSocketPath: string | null;
  /** env.ts readAppsSocket — the app host's admin socket (reload, the
   *  unregister sync, status's mounted half). */
  appsSocketPath: string | null;
  /** the cybermole install root: the templates live in it and its
   *  node_modules is what the scaffolded links point into. */
  installRoot: string;
  templateDir?: string | undefined;
  agentTemplateFile?: string | undefined;
  /** the child runner, injectable for tests */
  run?: typeof runChild | undefined;
}

// ---------- the local precheck for register (pure, unit-tested) ----------

export interface RegisterPrecheck {
  ok: boolean;
  /** the name the registration carries (the manifest's — §2: the
   *  manifest is the app's self-description) */
  name?: string;
  tree: string;
  /** a failure's wire JSON (the register_app family) */
  failure?: { errorCode: string; errorMessage: string };
}

export function registerPrecheck(appsRoot: string, slug: string): RegisterPrecheck {
  const tree = path.join(appsRoot, slug);
  let manifest: { name?: unknown } | null = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(tree, 'app.json'), 'utf8')) as {
      name?: unknown;
    };
  } catch {
    /* no tree or unreadable manifest — answered below */
  }
  if (manifest === null) {
    return {
      ok: false,
      tree,
      failure: {
        errorCode: 'tree_not_found',
        errorMessage: `no app tree at ${tree} — scaffold it first`,
      },
    };
  }
  const name = manifest.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return {
      ok: false,
      tree,
      failure: {
        errorCode: 'manifest_invalid',
        errorMessage: `app.json at ${tree} has no usable name — fix the manifest and re-run`,
      },
    };
  }
  return { ok: true, name: name.trim(), tree };
}

/** The register answer's one deliberate deviation from verbatim: the
 *  internal API's duplicate_slug text names the collision, not the
 *  recovery — the ANSWER must name it (plan §6): the human renames or
 *  unregisters the old group, and no tree is touched either way. */
function withDuplicateSlugRecovery(body: unknown): CallToolResult {
  if (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'duplicate_slug' &&
    typeof (body as { error?: unknown }).error === 'string'
  ) {
    const parsed = body as { error: string };
    parsed.error +=
      ' — recovery: a console-era grouping row may already own this slug. The human ' +
      'renames that app (the console) or unregisters it (the unregister tool); no tree ' +
      'is touched either way. The scaffolded tree stands at the apps root — register it ' +
      'under a new name only once the slug is free.';
  }
  return json(body);
}

// ---------- the socket verbs (the tools 1:1; the e2e loop calls the same functions) ----------

/** reload — POST /_admin/reload (the sync point). Verbatim report. */
export async function reloadTool(
  deps: AppsMcpDeps,
  slug: string | undefined,
): Promise<CallToolResult> {
  const r = await fetchSocket(
    deps.appsSocketPath,
    APPS_OFF,
    {
      method: 'POST',
      path: '/_admin/reload',
      body: JSON.stringify(slug === undefined ? {} : { slug }),
    },
    (sock, code, message) =>
      `could not reach the app host at ${sock} ${code ? `(${code})` : `: ${message}`} ` +
      '— a dead host shows as the console badge; this tool cannot sync without it',
    60_000,
  );
  return r.ok ? json(parseOrRaw(r.body)) : r.result;
}

/** register — the local precheck, then POST /apps (name from the
 *  manifest, cwd = the tree). duplicate_slug grows the recovery text. */
export async function registerTool(deps: AppsMcpDeps, slug: string): Promise<CallToolResult> {
  const pre = registerPrecheck(deps.appsRoot, slug);
  if (!pre.ok || pre.name === undefined) {
    return json({
      ok: false,
      resultType: 'register_app',
      errorCode: pre.failure!.errorCode,
      errorMessage: pre.failure!.errorMessage,
    });
  }
  const r = await fetchSocket(
    deps.internalSocketPath,
    INTERNAL_OFF,
    {
      method: 'POST',
      path: '/apps',
      body: JSON.stringify({ name: pre.name, cwd: pre.tree }),
    },
    unreachable,
  );
  if (!r.ok) return r.result;
  return withDuplicateSlugRecovery(parseOrRaw(r.body));
}

/** unregister — DELETE /apps/:slug (the row + cascade; the tree never
 *  touched), then the reload that drops the mount. */
export async function unregisterTool(deps: AppsMcpDeps, slug: string): Promise<CallToolResult> {
  const deleted = await fetchSocket(
    deps.internalSocketPath,
    INTERNAL_OFF,
    { method: 'DELETE', path: `/apps/${encodeURIComponent(slug)}` },
    unreachable,
  );
  if (!deleted.ok) return deleted.result;
  const body = parseOrRaw(deleted.body);
  // A green delete reloads (the sync point); a domain failure
  // (app_not_found …) is the API's verbatim answer, nothing to sync.
  if (deleted.status !== 200 || (body as { code?: unknown }).code !== undefined) {
    return json(body);
  }
  // A green delete syncs the mount away — EXCEPT when the apps surface
  // is off entirely: no host means nothing was ever mounted, so the row
  // deletion IS the whole story (an honest note, not an error — the
  // unreachable case below is the one that needs the operator's eyes).
  if (deps.appsSocketPath === null) {
    return json({
      unregister: body,
      reload: null,
      note: 'the row is deleted; the apps surface is off (CYBERMOLE_APPS_SOCK is empty) — no app host is running, so no mount exists to drop. Nothing further to do.',
    });
  }
  const reload = await fetchSocket(
    deps.appsSocketPath,
    APPS_OFF,
    { method: 'POST', path: '/_admin/reload', body: JSON.stringify({ slug }) },
    (sock, code, message) =>
      `the row is deleted, but the mount sync failed: could not reach the app host at ${sock} ` +
      `${code ? `(${code})` : `: ${message}`} — reload again once the host answers; until then the ` +
      'app still serves its last mounted build',
    60_000,
  );
  if (!reload.ok) return reload.result;
  return json({ unregister: body, reload: parseOrRaw(reload.body) });
}

/** status — the join (both sockets; transport failures are isError). */
export async function statusTool(
  deps: AppsMcpDeps,
  slug: string | undefined,
): Promise<CallToolResult> {
  const rows = await fetchSocket(
    deps.internalSocketPath,
    INTERNAL_OFF,
    { method: 'GET', path: '/apps' },
    unreachable,
  );
  if (!rows.ok) return rows.result;
  // A non-200 from either socket is that API's own failure JSON — verbatim,
  // a normal result (the module's contract: only TRANSPORT failures are
  // isError, never a domain code — a database_error on GET /apps is
  // information the model must read).
  if (rows.status !== 200) return json(parseOrRaw(rows.body));
  const host = await fetchSocket(
    deps.appsSocketPath,
    APPS_OFF,
    { method: 'GET', path: '/_admin/status' },
    (sock, code, message) =>
      `could not reach the app host at ${sock} ${code ? `(${code})` : `: ${message}`} ` +
      '— this tool cannot say what is mounted without it',
  );
  if (!host.ok) return host.result;
  if (host.status !== 200) return json(parseOrRaw(host.body));
  const rowsBody = parseOrRaw(rows.body) as { apps?: unknown };
  const hostBody = parseOrRaw(host.body) as StatusHostAnswer;
  const rowList = Array.isArray(rowsBody.apps)
    ? (rowsBody.apps as StatusAppRow[]).filter(r => typeof r?.slug === 'string')
    : [];
  let data = joinAppsStatus(deps.appsRoot, rowList, hostBody);
  if (slug !== undefined) {
    data = {
      ...data,
      apps: data.apps.filter(a => a.slug === slug),
      unregisteredTrees: data.unregisteredTrees.filter(s => s === slug),
    };
  }
  return json(data);
}

// ---------- the action vocabulary (add_action / describe / call — §6) ----------

/** describe — the app's route table from dist/route-table.json, VERBATIM
 *  (the emitted table: one entry per action — name, method, path, input
 *  schema, description). An unbuilt app is a DOMAIN answer naming the
 *  build, never isError. */
export async function describeTool(deps: AppsMcpDeps, slug: string): Promise<CallToolResult> {
  const read = readRouteTable(path.join(deps.appsRoot, slug));
  if (!read.ok) {
    return json({
      ok: false,
      resultType: 'describe_app',
      errorCode: read.errorCode,
      errorMessage: read.errorMessage,
    });
  }
  return json(read.table);
}

/** call — invoke one action through the host socket: THE request the
 *  table entry names (method + /apps/<slug> + path), params checked
 *  leniently against the emitted input (the app's own handler is the
 *  authority), the app's Result JSON answered VERBATIM. The root agent's
 *  use path — the same Result JSON the UI face answers (§0). */
export async function callActionTool(
  deps: AppsMcpDeps,
  input: { slug: string; action: string; params?: unknown },
): Promise<CallToolResult> {
  const read = readRouteTable(path.join(deps.appsRoot, input.slug));
  if (!read.ok) {
    return json({
      ok: false,
      resultType: 'call_action',
      errorCode: read.errorCode,
      errorMessage: read.errorMessage,
    });
  }
  const entry = findAction(read.table, input.action);
  if (entry === null) {
    return json({
      ok: false,
      resultType: 'call_action',
      errorCode: 'action_not_found',
      errorMessage: `the app ${input.slug} has no action "${input.action}" — its route table has: ${read.table.map(e => e.name).join(', ') || '(no actions)'}`,
    });
  }
  const planned = planActionRequest(input.slug, entry, input.params);
  if (!planned.ok) {
    return json({
      ok: false,
      resultType: 'call_action',
      errorCode: 'invalid_params',
      errorMessage: planned.errorMessage,
      ...(planned.issues ? { issues: planned.issues } : {}),
    });
  }
  const r = await fetchSocket(
    deps.appsSocketPath,
    APPS_OFF,
    {
      method: planned.request.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      path: `${planned.request.pathname}${planned.request.search ? `?${planned.request.search}` : ''}`,
      ...(planned.request.body !== undefined ? { body: planned.request.body } : {}),
    },
    (sock, code, message) =>
      `could not reach the app host at ${sock} ${code ? `(${code})` : `: ${message}`} ` +
      `— is the app ${input.slug} registered and the host running? status answers both`,
    30_000,
  );
  return r.ok ? json(parseOrRaw(r.body)) : r.result;
}

// ---------- the server ----------

/** Build the stdio MCP server. Paths are RESOLVED values (env.ts's
 *  readers — one logic), injected so units and the e2e loop drive the
 *  same code against hermetic worlds. */
export function createAppsMcpServer(deps: AppsMcpDeps): McpServer {
  const gateDeps = { appsRoot: deps.appsRoot, run: deps.run ?? runChild };
  const scaffoldDeps = {
    appsRoot: deps.appsRoot,
    templateDir: deps.templateDir ?? path.join(deps.installRoot, 'app-starter'),
    agentTemplateFile:
      deps.agentTemplateFile ?? path.join(deps.installRoot, 'apps-agent-template', 'AGENTS.md'),
    installRoot: deps.installRoot,
    run: deps.run ?? runChild,
  };

  const server = new McpServer({ name: 'cybermole-apps', version: '0.1.0' });

  server.registerTool(
    'scaffold',
    {
      description:
        'Scaffold a new cybermole app at the apps root from the image starter template: ' +
        'a real minimal Astro app on @cybermole/app-kit with one example action (ping) wired end to end, ' +
        "base '/apps/<slug>' baked, node_modules as per-package symlinks into the install's tree, a git repo " +
        "(first commit = the scaffold; agent undo is git clean) and the operator's AGENTS.md. The slug is " +
        'derived from the name like the console derives it, and is stable once created. Nothing registers or ' +
        'builds: check → register → reload is the loop.',
      inputSchema: {
        name: z.string().min(1).describe('the display name ("Notes Standup" → notes-standup)'),
        description: z
          .string()
          .optional()
          .describe('one line about what the app is for — lands in app.json and AGENTS.md'),
      },
    },
    async ({ name, description }) => json(await scaffoldApp(scaffoldDeps, { name, description })),
  );

  server.registerTool(
    'check',
    {
      description:
        "THE gate before any report of done on an app: run the tree's own check (astro check + tsc, its " +
        'unit tests, astro build with the route-table emission and the self-containment gate) in the tree, ' +
        'after first verifying the core node_modules links resolve — a bad install dies at the gate. One ' +
        'quiet envelope: read passed first, counts on a glance, failures[] for the detail. Re-run until green.',
      inputSchema: { slug: AppSlugSchema.describe('the app, by its slug') },
    },
    async ({ slug }) => json(await checkApp(gateDeps, slug)),
  );

  server.registerTool(
    'build',
    {
      description:
        "check's astro-build half alone: rebuild the app's dist/ (the route-table.json emission and the " +
        'self-containment gate ride the build script). After a green build of a REGISTERED app, reload ' +
        're-imports the new build at the host.',
      inputSchema: { slug: AppSlugSchema.describe('the app, by its slug') },
    },
    async ({ slug }) => json(await buildApp(gateDeps, slug)),
  );

  server.registerTool(
    'reload',
    {
      description:
        "Poke the app host's admin reload — the single sync point: the host re-runs discovery, then " +
        'mounts, re-imports (a rebuilt app) or drops the named app (every app when the slug is omitted). ' +
        'Run it after register, after unregister, and after rebuilding a registered app. The answer is the ' +
        "host's transition report (mounted/reimported/dropped/skipped) — for the post-state, status.",
      inputSchema: {
        slug: AppSlugSchema.optional().describe('scope the sync to one app; omit for every app'),
      },
    },
    async ({ slug }) => reloadTool(deps, slug),
  );

  server.registerTool(
    'register',
    {
      description:
        "Register a scaffolded app: write its db row through the internal API (name from the tree's " +
        'app.json, cwd = the tree). Registration is the privileged act (plan §8) — it creates the app group ' +
        'workspaces can attach to. After the row: reload (register + reload is the sync point that mounts). ' +
        'duplicate_slug names the recovery in its answer — no tree is touched.',
      inputSchema: { slug: AppSlugSchema.describe('the app, by its slug') },
    },
    async ({ slug }) => registerTool(deps, slug),
  );

  server.registerTool(
    'unregister',
    {
      description:
        'Unregister an app: delete its db row (the row + the cascade of its workspaces/terminals — the ' +
        'TREE is never touched, it stands at the apps root and status still shows it) and then reload, the ' +
        'sync point that drops the mount. Register again later to re-serve the same tree.',
      inputSchema: { slug: AppSlugSchema.describe('the app, by its slug') },
    },
    async ({ slug }) => unregisterTool(deps, slug),
  );

  server.registerTool(
    'status',
    {
      description:
        'The apps picture (§6): every app joined across its row (registered), the app host (mounted, and ' +
        'the serving REASON when not — the host names what is missing), and the tree (built, and build-stale: ' +
        'sources newer than the build). Also lists the unregistered trees present at the apps root (manifest ' +
        'but no row — scaffolded, not yet registered). Pass a slug to scope to one app.',
      inputSchema: {
        slug: AppSlugSchema.optional().describe('scope to one app; omit for the whole picture'),
      },
    },
    async ({ slug }) => statusTool(deps, slug),
  );

  server.registerTool(
    'add_action',
    {
      description:
        'THE action generator (§1 — route + MCP tool + UI stub + test stub + the AGENTS.md ' +
        "action section, all from one table entry): append one entry to the app's route table " +
        '(src/routes.ts — a working echo stub with a `text` input field, GET/POST as asked) and write ' +
        'every other face from it in lockstep — src/lib/<name>.ts (the Result family), ' +
        "tests/<name>.test.mjs (the tree's test glob runs it as-is), the UI island + its mount point on " +
        'the page, and the AGENTS.md BEGIN/END ACTIONS block regenerated from the table. Does NOT build ' +
        'or register — the loop stays agent-driven: check → build → reload. Idempotent by refusal: an ' +
        'existing action name answers action_exists, never a mangled file.',
      inputSchema: {
        slug: AppSlugSchema.describe('the app, by its slug'),
        name: ActionNameSchema.describe(
          "the action's name — kebab/snake case (normalizeSlug rules, underscores kept): the table entry, the MCP tool name and the file stem",
        ),
        summary: z
          .string()
          .max(200)
          .optional()
          .describe("one line of intent — the entry's description and the manual's section line"),
        method: z
          .enum(['GET', 'POST'])
          .optional()
          .describe(
            'where the input field lands: GET = query, POST = body. Default POST — an action does something',
          ),
      },
    },
    async ({ slug, name, summary, method }) =>
      json(await addAction({ appsRoot: deps.appsRoot }, { slug, name, summary, method })),
  );

  server.registerTool(
    'describe',
    {
      description:
        "The app's action vocabulary: dist/route-table.json VERBATIM — one entry per action (name, " +
        "method, path, input schema, description), the same table the app's pages, its own MCP shim and " +
        'call all bind from. An unbuilt app answers not_built naming the build; a stale table means the ' +
        'sources changed since — status reports buildStale.',
      inputSchema: { slug: AppSlugSchema.describe('the app, by its slug') },
    },
    async ({ slug }) => describeTool(deps, slug),
  );

  server.registerTool(
    'call',
    {
      description:
        "Invoke one app action through the app host — the root agent's use path (the same Result JSON " +
        "the app's UI and its own MCP tools answer, §0's one vocabulary). The request is the one the " +
        "table entry names; params are checked leniently against the emitted input schema and the app's " +
        'own handler is the authority — its failure JSON (ok:false, errorCode) comes back verbatim as a ' +
        'NORMAL result. Only a transport failure (host unreachable, apps surface off) is isError.',
      inputSchema: {
        slug: AppSlugSchema.describe('the app, by its slug'),
        action: z.string().min(1).describe('the action, by its table name (see describe)'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("the action's input fields, as describe's schema names them"),
      },
    },
    async ({ slug, action, params }) => callActionTool(deps, { slug, action, params }),
  );

  return server;
}

// ---------- the entry ----------

/** Resolve the env (apps root + both sockets) and serve over stdio.
 *  A bad env value (a non-absolute path) is stderr + exit 1 — the
 *  stop-the-boot stance every entry shares. Returns when the transport
 *  closes (the client closing stdin — how pi stops stdio servers). */
export async function main(): Promise<void> {
  let appsRoot: string;
  let internalSocketPath: string | null;
  let appsSocketPath: string | null;
  try {
    appsRoot = readAppsRoot();
    internalSocketPath = readInternalApiSocket();
    appsSocketPath = readAppsSocket();
  } catch (err) {
    console.error(`cybermole-apps mcp: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const server = createAppsMcpServer({
    appsRoot,
    internalSocketPath,
    appsSocketPath,
    installRoot: APP_ROOT,
  });
  await server.connect(new StdioServerTransport());
}

// The self-exec guard in the CommonJS build's terms (the compiled
// `import.meta.url === argv[1]` idiom — the server build emits CJS; see
// server/mcp.ts's note). This file is both the importable module (units,
// the e2e loop) and a runnable entry (the pi template's mcp.json).
if (require.main === module) {
  main().catch(err => {
    console.error(`cybermole-apps mcp: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
