// apps-actions.ts — the add_action half of the cybermole-apps MCP
// (task/app-actions, docs/apps-plan.md §6): THE action-vocabulary
// generator (§1: "route + MCP tool + UI stub + test stub + the AGENTS.md
// action section, all from one table entry"). One table entry is
// appended to the tree's src/routes.ts and everything else is written in
// lockstep from it: the domain module (src/lib/<name>.ts — ping's shape),
// the unit-test stub (tests/<name>.test.mjs — picked up by the tree's
// existing tests/*.test.mjs glob, no script edit), the UI island stub
// (src/islands/<Pascal>Island.tsx + its mount point on the page), and
// the operator manual's BEGIN/END ACTIONS block in AGENTS.md —
// REGENERATED from the table (read back from disk), so the manual cannot
// drift from the code (§7).
//
// add_action does NOT build: the loop stays agent-driven — the answer
// names it (check → build → reload). Idempotent by refusal: a name
// already in the table is a clear duplicate answer, never a mangled
// file; a target artifact that exists without its table entry means a
// hand-diverged tree and is refused too. All fs through this one
// boundary (CODE_STYLE §2): a failure is a Result, never a throw.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

// ---------- the action-name rule (defined once, reused) ----------

/** Longest action name — table entries are MCP tool names and file-name
 *  stems, so they cap like the slugs do. */
export const MAX_ACTION_NAME = 40;

/** Action names: kebab or snake, lowercase — the route-table name is the
 *  MCP tool name (the shim registers it verbatim, prefix-free) and a
 *  file-name stem, so it stays a URL-shaped identifier. Underscores stay
 *  legal (the kit's own fixture tables use snake names like
 *  note_create). */
export const ACTION_NAME_RE = new RegExp(`^[a-z0-9][a-z0-9_\\-]{0,${MAX_ACTION_NAME - 1}}$`);

/** Normalize an action name (the normalizeSlug rules, underscores kept):
 *  lowercase, runs of anything else collapse to '-', edges stripped,
 *  capped at MAX_ACTION_NAME. '' means nothing usable was typed. The
 *  output always satisfies ACTION_NAME_RE or is empty. */
export function normalizeActionName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, MAX_ACTION_NAME)
    .replace(/[^a-z0-9]+$/, '');
}

/** The MCP tool's input schema for the action name (the rule, once). */
export const ActionNameSchema = z
  .string()
  .min(1)
  .transform(normalizeActionName)
  .refine(v => ACTION_NAME_RE.test(v), {
    message: `an action name is kebab/snake case — lowercase letters, digits, "-" and "_", max ${MAX_ACTION_NAME} chars`,
  });

// ---------- identifier helpers (the generated files' names) ----------

/** 'note_create' / 'note-create' → 'noteCreate' (a valid TS identifier —
 *  the generated family's function name). */
export function actionCamel(name: string): string {
  const parts = name.split(/[-_]/).filter(p => p.length > 0);
  const [first, ...rest] = parts;
  return [first ?? '', ...rest.map(p => p[0]!.toUpperCase() + p.slice(1))].join('');
}

/** 'note_create' → 'NoteCreate' (the generated types' prefix). */
export function actionPascal(name: string): string {
  const camel = actionCamel(name);
  return camel[0]!.toUpperCase() + camel.slice(1);
}

// ---------- the light route-table parse (AGENTS.md regeneration) ----------

/** One entry as read back out of the tree's src/routes.ts — the table is
 *  the source of truth (§7), and the operator manual's actions block is
 *  rendered from exactly this. */
export interface ParsedAction {
  name: string;
  description: string;
  method: string;
  path: string;
  fields: Array<{ name: string; type: string; optional: boolean }>;
}

/** Scan out every `defineRoute({ … })` block, honoring quotes (a brace or
 *  apostrophe inside a description must not end the block). Total: an
 *  unparsable entry is skipped, never thrown. */
function defineRouteBlocks(source: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  for (;;) {
    const start = source.indexOf('defineRoute({', i);
    if (start < 0) break;
    const open = start + 'defineRoute('.length;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let j = open; j < source.length; j++) {
      const ch = source[j]!;
      if (quote !== null) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    blocks.push(source.slice(start, end + 1));
    i = end + 1;
  }
  return blocks;
}

const singleQuoted = (block: string, key: string): string | null => {
  const m = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(block);
  return m === null ? null : m[1]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
};

const FIELD_LINE_RE = /^[ \t]+([A-Za-z_$][A-Za-z0-9_$]*):[ \t]*z[.\s[(]/gm;

/** The entry's own property keys — schemas, not fields (params/query/body
 *  name z schemas themselves; their INDENTED members are the fields). */
const NAMESPACE_KEYS = new Set(['params', 'query', 'body']);

/** The input fields of one block: every `name: z…` property line inside
 *  its params/query/body schemas (the flattened key space the emitted
 *  table carries), with the declared scalar kind when the chain names
 *  one and whether it is optional. Best-effort by design — the emitted
 *  dist/route-table.json is the precise shape; this is the manual's one
 *  line per field. */
function parseFields(block: string): ParsedAction['fields'] {
  const matches = [...block.matchAll(FIELD_LINE_RE)].filter(m => !NAMESPACE_KEYS.has(m[1]!));
  const fields: ParsedAction['fields'] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const next = matches[i + 1];
    const chunk = block.slice(m.index ?? 0, next?.index ?? block.length);
    let type = 'value';
    if (chunk.includes('.string(')) type = 'string';
    else if (chunk.includes('.number(')) type = 'number';
    else if (chunk.includes('.boolean(')) type = 'boolean';
    else if (chunk.includes('z.enum(')) type = 'enum';
    fields.push({
      name: m[1]!,
      type,
      optional: chunk.includes('.optional(') || chunk.includes('.default('),
    });
  }
  return fields;
}

/** Parse the tree's src/routes.ts into its action list (the light parse —
 *  the kit's binder stays the real compiler; this reads only what the
 *  manual's block needs). Entries missing any core fact are skipped. */
export function parseRouteTableSource(source: string): ParsedAction[] {
  const actions: ParsedAction[] = [];
  for (const block of defineRouteBlocks(source)) {
    const name = singleQuoted(block, 'name');
    const description = singleQuoted(block, 'description');
    const method = singleQuoted(block, 'method');
    const actionPath = singleQuoted(block, 'path');
    if (name === null || description === null || method === null || actionPath === null) continue;
    actions.push({ name, description, method, path: actionPath, fields: parseFields(block) });
  }
  return actions;
}

/** One AGENTS.md section, from one parsed action. */
export function renderActionSection(slug: string, action: ParsedAction): string {
  const fields =
    action.fields.length === 0
      ? 'none'
      : action.fields
          .map(f => `\`${f.name}\` (${f.type}${f.optional ? ', optional' : ', required'})`)
          .join(', ');
  return [
    `### ${action.name}`,
    '',
    action.description,
    `- call: the \`${action.name}\` MCP tool, or the page's ${action.name} affordance, or \`${action.method} /apps/${slug}${action.path}\``,
    `- input: ${fields}`,
  ].join('\n');
}

export const ACTIONS_BEGIN_RE = /<!-- BEGIN ACTIONS[^\n]*-->/;
export const ACTIONS_END_RE = /<!-- END ACTIONS[^\n]*-->/;

/** The whole marked block's inner content: one section per action, in
 *  table order. */
export function renderActionsBlock(slug: string, actions: ParsedAction[]): string {
  return `${actions.map(a => renderActionSection(slug, a)).join('\n\n')}\n`;
}

export const ACTIONS_INTRO = [
  'One section per action, REGENERATED from `src/routes.ts` by the scaffold',
  'and by `add_action` — edit around this block, never in it (a regenerated',
  'block wins; the manual cannot drift from the code).',
  '',
].join('\n');

export const ACTIONS_BEGIN_LINE =
  '<!-- BEGIN ACTIONS (generated from src/routes.ts — do not edit inside) -->';
export const ACTIONS_END_LINE = '<!-- END ACTIONS -->';

export interface AgentsRegen {
  text: string;
  /** the markers were absent — a fresh `## Actions` section was inserted
   *  (before `## Policy`, or appended at the end) */
  appendedFresh: boolean;
}

/** Regenerate the tree's AGENTS.md actions block from its route table.
 *  The markers' neighborhood is preserved byte-for-byte; only the content
 *  between them is replaced. Idempotent: regenerating what regeneration
 *  wrote changes nothing. */
export function regenerateAgentsActions(
  agentsText: string,
  slug: string,
  actions: ParsedAction[],
): AgentsRegen {
  const content = renderActionsBlock(slug, actions);
  const begin = ACTIONS_BEGIN_RE.exec(agentsText);
  const end = ACTIONS_END_RE.exec(agentsText);
  if (begin !== null && end !== null && begin.index < end.index) {
    const afterBegin = begin.index + begin[0].length;
    return {
      text: agentsText.slice(0, afterBegin) + `\n${content}` + agentsText.slice(end.index),
      appendedFresh: false,
    };
  }
  const section = `## Actions\n\n${ACTIONS_INTRO}${ACTIONS_BEGIN_LINE}\n${content}${ACTIONS_END_LINE}\n`;
  const policy = agentsText.indexOf('## Policy');
  if (policy >= 0) {
    return {
      text: `${agentsText.slice(0, policy)}${section}\n${agentsText.slice(policy)}`,
      appendedFresh: true,
    };
  }
  const text = agentsText.endsWith('\n') || agentsText === '' ? agentsText : `${agentsText}\n`;
  return { text: `${text}${section}`, appendedFresh: true };
}

// ---------- the generated artifacts (the starter template's shapes) ----------

export interface AddActionInput {
  slug: string;
  /** the action's name — normalized (normalizeActionName) before use */
  name: string;
  /** one line of intent — the table entry's description and the manual's
   *  section line. Default names it a generated stub. */
  summary?: string | undefined;
  /** GET (input lands in the query) or POST (input lands in the body).
   *  Default POST — an action does something. */
  method?: 'GET' | 'POST' | undefined;
}

export type AddActionData = {
  slug: string;
  tree: string;
  /** the normalized action name (the table entry, tool name, file stem) */
  action: string;
  method: 'GET' | 'POST';
  /** every artifact written, in write order — the answer's inventory */
  written: Array<{ file: string; what: string }>;
  /** honest asides: the page's mount markers were appended fresh, the
   *  manual's section was inserted fresh, the page was missing… */
  notes: string[];
  /** the loop (§1) — add_action never builds; these are the next verbs */
  next: string[];
};
export type AddActionErrorCode =
  'tree_not_found' | 'invalid_name' | 'action_exists' | 'artifact_exists' | 'write_failed';
export type AddActionSuccess = ResultSuccess<'add_action', AddActionData>;
export type AddActionFailure = ResultFailure<'add_action', AddActionData, AddActionErrorCode>;
export type AddActionResult = AddActionSuccess | AddActionFailure;

export interface AddActionDeps {
  appsRoot: string;
}

const fail = (errorCode: AddActionErrorCode, errorMessage: string): AddActionFailure => ({
  ok: false,
  resultType: 'add_action',
  errorCode,
  errorMessage,
});

/** The sample input field every generated stub carries (ping's `name`,
 *  generalized): required, trimmed, 1–500 chars. */
const SAMPLE_FIELD = 'text';
const SAMPLE_MAX = 500;

const generatedSummary = (name: string): string =>
  `the ${name} action — a generated stub; edit this line (and src/lib/${name}.ts) to say and do what it should`;

function generatedLib(name: string, camel: string, pascal: string): string {
  return `// The ${name} action's logic — GENERATED by the cybermole-apps add_action
// tool as a working stub (one Result family per concern, docs/CODE_STYLE.md
// §1 — the house rules this template bakes in). Kept node-free AND
// runtime-kit-free (the family's TYPES are an \`import type\` — stripped
// before execution) so the unit tests import this file with plain node
// (see src/lib/ping.ts, the pattern this follows). Replace the echo with
// the action's real logic; tests/${name}.test.mjs grows with it.
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

export type ${pascal}Data = { received: string; at: number };
export type ${pascal}ErrorCode = 'invalid_${SAMPLE_FIELD}';
export type ${pascal}Success = ResultSuccess<'${name}', ${pascal}Data>;
export type ${pascal}Failure = ResultFailure<'${name}', ${pascal}Data, ${pascal}ErrorCode>;
export type ${pascal}Result = ${pascal}Success | ${pascal}Failure;

export function ${camel}Result(raw${actionPascal(SAMPLE_FIELD)}: string): ${pascal}Result {
  const ${SAMPLE_FIELD} = raw${actionPascal(SAMPLE_FIELD)}.trim();
  if (${SAMPLE_FIELD}.length === 0) {
    return {
      ok: false,
      resultType: '${name}',
      errorCode: 'invalid_${SAMPLE_FIELD}',
      errorMessage: '${SAMPLE_FIELD} is required',
    } satisfies ${pascal}Failure;
  }
  if (${SAMPLE_FIELD}.length > ${SAMPLE_MAX}) {
    return {
      ok: false,
      resultType: '${name}',
      errorCode: 'invalid_${SAMPLE_FIELD}',
      errorMessage: '${SAMPLE_FIELD} is too long (max ${SAMPLE_MAX} chars)',
    } satisfies ${pascal}Failure;
  }
  return {
    ok: true,
    resultType: '${name}',
    data: { received: ${SAMPLE_FIELD}, at: Date.now() },
  } satisfies ${pascal}Success;
}
`;
}

function generatedRouteEntry(
  name: string,
  summary: string,
  method: 'GET' | 'POST',
  camel: string,
): string {
  const input = `      ${SAMPLE_FIELD}: z
        .string()
        .trim()
        .min(1, '${SAMPLE_FIELD} is required')
        .max(${SAMPLE_MAX}, '${SAMPLE_FIELD} is too long (max ${SAMPLE_MAX} chars)'),`;
  const where = method === 'GET' ? 'query' : 'body';
  return `  defineRoute({
    name: '${name}',
    description: '${summary.replace(/'/g, "\\'")}',
    method: '${method}',
    path: '/api/${name}',
    params: z.object({}),
    ${where}: z.object({
${input}
    }),
    errorStatus: { invalid_${SAMPLE_FIELD}: 400 },
    handler: ({ ${where} }) => ${camel}Result(${where}.${SAMPLE_FIELD}),
  }),`;
}

function generatedTest(name: string, camel: string): string {
  return `// The ${name} action's unit tests — GENERATED by the cybermole-apps
// add_action tool as a working stub (ping.test.mjs's shape: one test per
// error code, not just the happy path — docs/CODE_STYLE.md §9). Grow it
// with the action's real logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ${camel}Result } from '../src/lib/${name}.ts';

test('${name}: a ${SAMPLE_FIELD} answers received', () => {
  const r = ${camel}Result('hello');
  assert.equal(r.ok, true);
  if (!r.ok) return; // narrow for the type checker's sake
  assert.equal(r.data.received, 'hello');
  assert.equal(typeof r.data.at, 'number');
});

test('${name}: an empty ${SAMPLE_FIELD} answers invalid_${SAMPLE_FIELD}', () => {
  const r = ${camel}Result('   ');
  assert.deepEqual(r, {
    ok: false,
    resultType: '${name}',
    errorCode: 'invalid_${SAMPLE_FIELD}',
    errorMessage: '${SAMPLE_FIELD} is required',
  });
});

test('${name}: a too-long ${SAMPLE_FIELD} answers invalid_${SAMPLE_FIELD}', () => {
  const r = ${camel}Result('x'.repeat(${SAMPLE_MAX + 1}));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.errorCode, 'invalid_${SAMPLE_FIELD}');
  assert.match(r.errorMessage, /too long/);
});
`;
}

function generatedIsland(
  name: string,
  camel: string,
  pascal: string,
  method: 'GET' | 'POST',
): string {
  const call = `client.${name}({ params: {}, ${method === 'GET' ? 'query' : 'body'}: { ${SAMPLE_FIELD} } })`;
  return `// ${pascal}Island.tsx — the ${name} action's UI: GENERATED by the cybermole-apps
// add_action tool as a working stub (a preact island with signals, the
// kit's convention — the action call goes through the kit's typed client
// on the SAME table the API route serves: one action vocabulary, every
// face, apps-plan §0). Shape it into the app's real UI.
import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { createRouteClient } from '@cybermole/app-kit/route-table';
import { routes } from '../routes';

/** The wa-input host after the browser upgrades it (before that, .value
 *  is absent — the island reads it defensively). */
interface WaInputHost extends HTMLElement {
  value: string | null;
}

const client = createRouteClient(routes, { base: import.meta.env.BASE_URL });
const result = signal('— not sent yet —');

export default function ${pascal}Island() {
  const input = useRef<WaInputHost | null>(null);
  const go = async () => {
    const ${SAMPLE_FIELD} = (input.current?.value ?? '').trim();
    result.value = '…';
    const r = await ${call};
    result.value = r.ok
      ? \`ok: received \${r.data.received}\`
      : \`error: \${r.errorMessage ?? r.errorCode}\`;
  };
  return (
    <>
      <wa-input label="${SAMPLE_FIELD}" ref={input}></wa-input>{' '}
      <wa-button variant="brand" onClick={go}>
        ${name}
      </wa-button>
      <p aria-live="polite">{result.value}</p>
    </>
  );
}
`;
}

// ---------- the page's marked mount blocks ----------

export const MOUNT_BEGIN =
  '<!-- BEGIN ACTION MOUNTS (generated — add_action appends one section per action) -->';
export const MOUNT_END = '<!-- END ACTION MOUNTS -->';
export const ISLAND_BEGIN =
  '// BEGIN ACTION ISLANDS (generated — add_action appends one import + mount per action)';
export const ISLAND_END = '// END ACTION ISLANDS';

function generatedPageSection(name: string): string {
  return `        <section class="${name}-island">
          <wa-input label="${SAMPLE_FIELD}"></wa-input>
          <wa-button variant="brand">${name}</wa-button>
          <p aria-live="polite">— not sent yet —</p>
        </section>
`;
}

function generatedPageMount(name: string, pascal: string): string {
  return `      import ${pascal}Island from '../islands/${pascal}Island';
      mountIsland('.${name}-island', ${pascal}Island, {});
`;
}

export interface PageInsert {
  text: string;
  /** the marked block was absent — a fresh one was appended */
  appendedFresh: boolean;
}

/** Insert one section before the mount block's END marker, appending a
 *  fresh marked block before </main> when the markers are gone (a page
 *  that diverged still gets its affordance, honestly noted). */
function insertIntoMountBlock(page: string, section: string): PageInsert {
  const begin = page.indexOf(MOUNT_BEGIN);
  const end = page.indexOf(MOUNT_END);
  if (begin >= 0 && end > begin) {
    return {
      text: `${page.slice(0, end)}${section}${page.slice(end)}`,
      appendedFresh: false,
    };
  }
  const fresh = `      ${MOUNT_BEGIN}\n${section}      ${MOUNT_END}\n`;
  const main = page.lastIndexOf('</main>');
  if (main >= 0) {
    return {
      text: `${page.slice(0, main)}${fresh}${page.slice(main)}`,
      appendedFresh: true,
    };
  }
  return { text: `${page}\n${fresh}`, appendedFresh: true };
}

function insertIntoIslandBlock(page: string, mount: string): PageInsert {
  const begin = page.indexOf(ISLAND_BEGIN);
  const end = page.indexOf(ISLAND_END);
  if (begin >= 0 && end > begin) {
    return {
      text: `${page.slice(0, end)}${mount}${page.slice(end)}`,
      appendedFresh: false,
    };
  }
  const scriptEnd = page.lastIndexOf('</script>');
  const fresh = `      ${ISLAND_BEGIN}\n${mount}      ${ISLAND_END}\n`;
  if (scriptEnd >= 0) {
    return {
      text: `${page.slice(0, scriptEnd)}${fresh}${page.slice(scriptEnd)}`,
      appendedFresh: true,
    };
  }
  return { text: `${page}\n${fresh}`, appendedFresh: true };
}

// ---------- the generator ----------

/** Generate one action into an app tree, in lockstep from one table
 *  entry. Never throws; never overwrites an unexpected file; never
 *  builds (the answer names the loop: check → build → reload). */
export async function addAction(
  deps: AddActionDeps,
  input: AddActionInput,
): Promise<AddActionResult> {
  const tree = path.join(deps.appsRoot, input.slug);
  const data: AddActionData = {
    slug: input.slug,
    tree,
    action: '',
    method: input.method ?? 'POST',
    written: [],
    notes: [],
    next: [],
  };
  const routesPath = path.join(tree, 'src', 'routes.ts');
  if (!fs.existsSync(routesPath)) {
    return fail(
      'tree_not_found',
      `no app tree at ${tree} (src/routes.ts is missing) — scaffold the app first; the apps root is ${deps.appsRoot}`,
    );
  }
  const name = normalizeActionName(input.name);
  if (name === '' || !ACTION_NAME_RE.test(name)) {
    return fail(
      'invalid_name',
      `the name ${JSON.stringify(input.name)} normalizes to ${JSON.stringify(name)} — an action name needs lowercase letters or digits (kebab/snake case, max ${MAX_ACTION_NAME} chars)`,
    );
  }
  data.action = name;
  const camel = actionCamel(name);
  const pascal = actionPascal(name);
  const summary = (input.summary ?? '').trim() || generatedSummary(name);
  const method = input.method ?? 'POST';

  // The table is the arbiter of existence (idempotence): a name already
  // there is a clear duplicate answer; a target artifact that exists
  // WITHOUT its table entry is a diverged tree — refused, never mangled.
  const routesSource = fs.readFileSync(routesPath, 'utf8');
  const existing = parseRouteTableSource(routesSource).map(a => a.name);
  if (existing.includes(name)) {
    return fail(
      'action_exists',
      `the route table at ${routesPath} already has a ${JSON.stringify(name)} action — extend it by hand instead, or pick another name (present: ${existing.join(', ')})`,
    );
  }
  const collisions = [
    path.join('src', 'lib', `${name}.ts`),
    path.join('tests', `${name}.test.mjs`),
    path.join('src', 'islands', `${pascal}Island.tsx`),
  ].filter(rel => fs.existsSync(path.join(tree, rel)));
  if (collisions.length > 0) {
    return fail(
      'artifact_exists',
      `${collisions.join(', ')} already exist but the route table has no ${JSON.stringify(name)} action — a hand-diverged tree; resolve by hand (the generator never overwrites)`,
    );
  }

  try {
    // 1 — the domain module (ping.ts's shape), before the entry imports it.
    fs.writeFileSync(
      path.join(tree, 'src', 'lib', `${name}.ts`),
      generatedLib(name, camel, pascal),
    );
    data.written.push({
      file: `src/lib/${name}.ts`,
      what: 'the action’s Result family — a working echo stub (replace with real logic; its tests grow with it)',
    });

    // 2 — THE table entry: everything else binds from this one line of
    // truth (the entry + its import, appended after the last import).
    const importLine = `import { ${camel}Result } from './lib/${name}';\n`;
    const importAnchor = routesSource.match(/(?:^import[^\n]*\n)+/m);
    const withImport =
      importAnchor !== null
        ? routesSource.replace(importAnchor[0], `${importAnchor[0]}${importLine}`)
        : `${importLine}\n${routesSource}`;
    const closeArray = withImport.lastIndexOf('\n];');
    const routesText =
      closeArray >= 0
        ? `${withImport.slice(0, closeArray)}\n${generatedRouteEntry(name, summary, method, camel)}${withImport.slice(closeArray)}`
        : `${withImport}\nexport const routes: RouteTable = [\n${generatedRouteEntry(name, summary, method, camel)},\n];\n`;
    fs.writeFileSync(routesPath, routesText);
    data.written.push({
      file: 'src/routes.ts',
      what: `the table entry (${method} /api/${name}) + its import — the one entry every face (HTTP, shim tools, describe/call) binds from`,
    });

    // 3 — the unit-test stub; the tree's `test` script (tests/*.test.mjs
    // glob) picks it up with no edit.
    fs.writeFileSync(path.join(tree, 'tests', `${name}.test.mjs`), generatedTest(name, camel));
    data.written.push({
      file: `tests/${name}.test.mjs`,
      what: 'the unit-test stub (one test per error code) — the tree’s test glob runs it as-is',
    });

    // 4 — the island stub + its page mount points (the minimal honest
    // affordance on an existing page: a section the island takes over).
    fs.writeFileSync(
      path.join(tree, 'src', 'islands', `${pascal}Island.tsx`),
      generatedIsland(name, camel, pascal, method),
    );
    data.written.push({
      file: `src/islands/${pascal}Island.tsx`,
      what: 'the UI island stub (preact + signals, the typed client)',
    });
    const pagePath = path.join(tree, 'src', 'pages', 'index.astro');
    if (fs.existsSync(pagePath)) {
      const page = fs.readFileSync(pagePath, 'utf8');
      const withSection = insertIntoMountBlock(page, generatedPageSection(name));
      const withMount = insertIntoIslandBlock(withSection.text, generatedPageMount(name, pascal));
      fs.writeFileSync(pagePath, withMount.text);
      if (withSection.appendedFresh)
        data.notes.push(
          'src/pages/index.astro had no ACTION MOUNTS markers — a fresh marked block was appended (the page diverged from the scaffold shape)',
        );
      if (withMount.appendedFresh)
        data.notes.push(
          'src/pages/index.astro had no ACTION ISLANDS markers — a fresh marked block was appended in the client script',
        );
      data.written.push({
        file: 'src/pages/index.astro',
        what: 'the island’s mount points (the SSR section + the client-script import/mount)',
      });
    } else {
      data.notes.push(
        'src/pages/index.astro not found — the UI stub island was written, but no page mount was added; wire it by hand',
      );
    }

    // 5 — the operator manual: the BEGIN/END ACTIONS block, REGENERATED
    // from the table as it now stands on disk (read back — the source of
    // truth, never the generator's memory of what it wrote).
    const agentsPath = path.join(tree, 'AGENTS.md');
    const agentsText = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
    const regen = regenerateAgentsActions(
      agentsText,
      input.slug,
      parseRouteTableSource(fs.readFileSync(routesPath, 'utf8')),
    );
    fs.writeFileSync(agentsPath, regen.text);
    if (regen.appendedFresh)
      data.notes.push(
        'AGENTS.md had no BEGIN/END ACTIONS markers — a fresh ## Actions section was inserted',
      );
    data.written.push({
      file: 'AGENTS.md',
      what: 'the BEGIN/END ACTIONS block, regenerated from src/routes.ts (the manual cannot drift from the table)',
    });
  } catch (err) {
    return {
      ...fail(
        'write_failed',
        `could not write the ${name} action into ${tree}: ${(err as Error).message}`,
      ),
      data,
    };
  }

  data.next = [
    `check — the check tool (slug ${input.slug}): the gate (typecheck + the grown unit tests + the build that emits dist/route-table.json with the action)`,
    `build — the build tool alone, when only the dist/ artifacts are wanted`,
    `reload — the reload tool: serve the new build (once the app is registered)`,
  ];
  return {
    ok: true,
    resultType: 'add_action',
    data,
  } satisfies AddActionSuccess;
}
