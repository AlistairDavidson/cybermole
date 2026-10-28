// Apps MCP server (`cybermole-apps`): the root agent's build loop (scaffold,
// check, build, register, reload, unregister, status) and action vocabulary
// (add_action, describe, call).
//
// Socket-backed tools return the APIs' JSON verbatim; isError is reserved for
// transport failures. Local tools answer their own Result or quiet envelope,
// where a red result is information, not isError.
//
// stdout is the protocol channel, so nothing logs to it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppSlugSchema } from '@cybermole/app-kit';
import {
  APP_ROOT,
  readAppsRoot,
  readAppsSocket,
  readInternalApiSocket,
} from '../src/lib/platform/env';
import { runChild } from '../src/lib/apps/apps-child';
import { scaffoldApp } from '../src/lib/apps/apps-scaffold';
import { buildApp, checkApp } from '../src/lib/apps/apps-gate';
import { isAppIcon } from '../src/lib/apps/app-icons';
import { ActionNameSchema, addAction } from '../src/lib/apps/apps-actions';
import { findAction, planActionRequest, readRouteTable } from '../src/lib/apps/apps-route-table';
import {
  joinAppsStatus,
  type StatusAppRow,
  type StatusHostAnswer,
} from '../src/lib/apps/apps-status';
import {
  requestInternalApi,
  type InternalApiAnswer,
} from '../src/lib/platform/internal-api-client';

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

/** A 4xx/5xx body is the API's own failure JSON: return it verbatim, not as isError. */
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
  appsRoot: string;
  /** null: listener off. */
  internalSocketPath: string | null;
  /** The app host's admin socket. */
  appsSocketPath: string | null;
  /** Holds the templates; scaffolded node_modules link into it. */
  installRoot: string;
  templateDir?: string | undefined;
  agentTemplateFile?: string | undefined;
  run?: typeof runChild | undefined;
}

// ---------- register precheck ----------

export interface RegisterPrecheck {
  ok: boolean;
  /** From the manifest. */
  name?: string;
  /** From the manifest; validated — an unknown name is left for the row's
   *  suggestion, never a failing register. */
  icon?: string;
  tree: string;
  failure?: { errorCode: string; errorMessage: string };
}

export function registerPrecheck(appsRoot: string, slug: string): RegisterPrecheck {
  const tree = path.join(appsRoot, slug);
  let manifest: { name?: unknown; icon?: unknown } | null = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(tree, 'app.json'), 'utf8')) as {
      name?: unknown;
      icon?: unknown;
    };
  } catch {
    /* answered below */
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
  const icon =
    typeof manifest.icon === 'string' && isAppIcon(manifest.icon) ? manifest.icon : undefined;
  return { ok: true, name: name.trim(), ...(icon === undefined ? {} : { icon }), tree };
}

/** The one deviation from verbatim: add the recovery to duplicate_slug's text. */
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

// ---------- socket verbs ----------

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

/** Name (and icon, when the manifest carries a known one) from the
 *  manifest, cwd = the tree. */
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
      body: JSON.stringify({
        name: pre.name,
        cwd: pre.tree,
        ...(pre.icon === undefined ? {} : { icon: pre.icon }),
      }),
    },
    unreachable,
  );
  if (!r.ok) return r.result;
  return withDuplicateSlugRecovery(parseOrRaw(r.body));
}

/** Deletes the row (never the tree), then reloads to drop the mount. */
export async function unregisterTool(deps: AppsMcpDeps, slug: string): Promise<CallToolResult> {
  const deleted = await fetchSocket(
    deps.internalSocketPath,
    INTERNAL_OFF,
    { method: 'DELETE', path: `/apps/${encodeURIComponent(slug)}` },
    unreachable,
  );
  if (!deleted.ok) return deleted.result;
  const body = parseOrRaw(deleted.body);
  if (deleted.status !== 200 || (body as { code?: unknown }).code !== undefined) {
    return json(body);
  }
  // Apps surface off: nothing was ever mounted, so the delete is the whole story.
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
  // A non-200 is the API's own failure JSON: a normal result, not isError.
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

// ---------- action vocabulary ----------

/** dist/route-table.json verbatim; an unbuilt app is a domain answer, not isError. */
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

/** Params are checked leniently; the app's own handler is the authority. */
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

// ---------- server ----------

export function createAppsMcpServer(deps: AppsMcpDeps): McpServer {
  const gateDeps = {
    appsRoot: deps.appsRoot,
    installRoot: deps.installRoot,
    run: deps.run ?? runChild,
  };
  const scaffoldDeps = {
    appsRoot: deps.appsRoot,
    templateDir: deps.templateDir ?? path.join(deps.installRoot, 'runtime', 'app-starter'),
    agentTemplateFile:
      deps.agentTemplateFile ?? path.join(deps.installRoot, 'runtime', 'app-agents', 'AGENTS.md'),
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
        icon: z
          .string()
          .optional()
          .describe(
            "the app's icon, one of the vendored names (cubes, file-lines, code, robot, terminal, folder, gear, clock, play, download, magnifying-glass, pencil, copy, circle-check, circle-info, triangle-exclamation, eye, eye-slash, arrows-rotate, rotate-right) — omitted, the name suggests one; lands in app.json, so register puts it on the row",
          ),
      },
    },
    async ({ name, description, icon }) =>
      json(await scaffoldApp(scaffoldDeps, { name, description, icon })),
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
        'app.json, cwd = the tree). Registration is the privileged act — it creates the app group ' +
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
        'The apps picture: every app joined across its row (registered), the app host (mounted, and ' +
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
        'THE action generator (route + MCP tool + a signals store + a component ' +
        'directory (SSR .astro + enhancer) + its page wiring + test stub + the ' +
        'AGENTS.md action section, all from one table entry): append one entry to ' +
        "the app's route table (src/routes.ts — a working echo stub with a `text` " +
        'input field, GET/POST as asked) and write every other face from it in ' +
        'lockstep — src/lib/<name>.ts (the Result family), tests/<name>.test.mjs ' +
        "(the tree's test glob runs it as-is), the store + the component directory " +
        "(src/components/<Pascal>/ — the .astro SSR + its enhancer) + the page's " +
        'import, mount and enhancer import inside the generated markers, and the ' +
        'AGENTS.md BEGIN/END ACTIONS block regenerated from the table. Does NOT ' +
        'build or register — the loop stays agent-driven: check → build → ' +
        'reload. Idempotent by refusal: an existing action name answers ' +
        'action_exists, never a mangled file.',
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
        "the app's UI and its own MCP tools answer, one vocabulary). The request is the one the " +
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

// ---------- entry ----------

/** A bad env value is reported on stderr with exit 1. */
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

// The CJS build's self-exec guard: this file is both a module and an entry.
if (require.main === module) {
  main().catch(err => {
    console.error(`cybermole-apps mcp: ${(err as Error).stack ?? err}`);
    process.exitCode = 1;
  });
}
