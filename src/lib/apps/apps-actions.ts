// add_action: generates one action into an app tree from one route-table
// entry: the entry in src/routes.ts, src/lib/<name>.ts, a test stub, a
// store, a component directory (SSR .astro + enhancer) and the page wiring
// for it, and the AGENTS.md actions block regenerated from the table (so
// the manual can't drift). It never builds, and refuses rather than
// overwrite: an existing name, or an artifact without its table entry.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ResultFailure, ResultSuccess } from '@cybermole/app-kit';

// ---------- action names ----------

/** Names double as MCP tool names and file stems. */
export const MAX_ACTION_NAME = 40;

/** Lowercase kebab or snake case (snake is used, e.g. note_create). */
export const ACTION_NAME_RE = new RegExp(`^[a-z0-9][a-z0-9_\\-]{0,${MAX_ACTION_NAME - 1}}$`);

/** normalizeSlug's rules with underscores kept; '' means nothing usable. */
export function normalizeActionName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, MAX_ACTION_NAME)
    .replace(/[^a-z0-9]+$/, '');
}

export const ActionNameSchema = z
  .string()
  .min(1)
  .transform(normalizeActionName)
  .refine(v => ACTION_NAME_RE.test(v), {
    message: `an action name is kebab/snake case — lowercase letters, digits, "-" and "_", max ${MAX_ACTION_NAME} chars`,
  });

// ---------- identifiers ----------

/** 'note_create' / 'note-create' → 'noteCreate' */
export function actionCamel(name: string): string {
  const parts = name.split(/[-_]/).filter(p => p.length > 0);
  const [first, ...rest] = parts;
  return [first ?? '', ...rest.map(p => p[0]!.toUpperCase() + p.slice(1))].join('');
}

/** 'note_create' → 'NoteCreate' */
export function actionPascal(name: string): string {
  const camel = actionCamel(name);
  return camel[0]!.toUpperCase() + camel.slice(1);
}

// ---------- route-table parse (for AGENTS.md) ----------

export interface ParsedAction {
  name: string;
  description: string;
  method: string;
  path: string;
  fields: Array<{ name: string; type: string; optional: boolean }>;
}

/** Honors quotes, so a brace in a description doesn't end the block. Never throws. */
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

/** params/query/body are namespaces only when their value is an object
 *  schema; a field named `body: z.string()` is a field. */
const NAMESPACE_KEYS = new Set(['params', 'query', 'body']);
const NAMESPACE_VALUE_RE = /^z\s*\.\s*(?:looseObject|object)\s*\(/;

/** Best-effort: the emitted dist/route-table.json is the precise shape;
 *  this only feeds one manual line per field. */
function parseFields(block: string): ParsedAction['fields'] {
  const matches = [...block.matchAll(FIELD_LINE_RE)].filter(m => {
    if (!NAMESPACE_KEYS.has(m[1]!)) return true;
    // the match ends one char into the value, so back up to the schema's name
    const value = block.slice((m.index ?? 0) + m[0].length - 2);
    return !NAMESPACE_VALUE_RE.test(value);
  });
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

/** A light parse for the manual; entries missing a core fact are skipped. */
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

export function renderActionSection(slug: string, action: ParsedAction, base = '/'): string {
  const fields =
    action.fields.length === 0
      ? 'none'
      : action.fields
          .map(f => `\`${f.name}\` (${f.type}${f.optional ? ', optional' : ', required'})`)
          .join(', ');
  const lines = [
    `### ${action.name}`,
    '',
    action.description,
    `- call: the \`${action.name}\` MCP tool, or the page's ${action.name} affordance, or \`${action.method} ${base === '/' ? '' : base}/apps/${slug}${action.path}\``,
    `- input: ${fields}`,
  ];
  // §7's no-JS rule: an action whose UI posts JSON says so in its docs.
  if (action.method !== 'GET')
    lines.push('- ui: requires JS (a JSON body — no native-form fallback)');
  return lines.join('\n');
}

export const ACTIONS_BEGIN_RE = /<!-- BEGIN ACTIONS[^\n]*-->/;
export const ACTIONS_END_RE = /<!-- END ACTIONS[^\n]*-->/;

export function renderActionsBlock(slug: string, actions: ParsedAction[], base = '/'): string {
  return `${actions.map(a => renderActionSection(slug, a, base)).join('\n\n')}\n`;
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
  /** markers were absent; a fresh `## Actions` section was inserted */
  appendedFresh: boolean;
}

/** Only the content between the markers is replaced. Idempotent. */
export function regenerateAgentsActions(
  agentsText: string,
  slug: string,
  actions: ParsedAction[],
  base = '/',
): AgentsRegen {
  const content = renderActionsBlock(slug, actions, base);
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

// ---------- generated artifacts ----------

export interface AddActionInput {
  slug: string;
  name: string;
  /** one line; defaults to naming it a generated stub */
  summary?: string | undefined;
  /** Where the input lands (query or body). Default POST. */
  method?: 'GET' | 'POST' | undefined;
}

export type AddActionData = {
  slug: string;
  tree: string;
  /** normalized */
  action: string;
  method: 'GET' | 'POST';
  /** in write order */
  written: Array<{ file: string; what: string }>;
  notes: string[];
  /** the verbs to run next; add_action never builds */
  next: string[];
};
export type AddActionErrorCode =
  'tree_not_found' | 'invalid_name' | 'action_exists' | 'artifact_exists' | 'write_failed';
export type AddActionSuccess = ResultSuccess<'add_action', AddActionData>;
export type AddActionFailure = ResultFailure<'add_action', AddActionData, AddActionErrorCode>;
export type AddActionResult = AddActionSuccess | AddActionFailure;

export interface AddActionDeps {
  appsRoot: string;
  /** The console's normalized URL base (readBase() shape), so the AGENTS.md
   *  action docs name the real console-origin URL. Default: site root. */
  base?: string;
}

const fail = (errorCode: AddActionErrorCode, errorMessage: string): AddActionFailure => ({
  ok: false,
  resultType: 'add_action',
  errorCode,
  errorMessage,
});

/** Every stub gets this one required input field. */
const SAMPLE_FIELD = 'text';
const SAMPLE_MAX = 500;

const generatedSummary = (name: string): string =>
  `the ${name} action — a generated stub; edit this line (and src/lib/${name}.ts) to say and do what it should`;

function generatedLib(name: string, camel: string, pascal: string): string {
  return `// The ${name} action's logic, generated by add_action as an echo stub.
// Node-free (type-only kit imports) so the unit tests run it with plain node.
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

const escapeSingleQuoted = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

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
    description: '${escapeSingleQuoted(summary)}',
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
  return `// Unit tests for ${name}, generated by add_action: one test per error code.
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

function generatedStore(name: string, camel: string, method: 'GET' | 'POST'): string {
  // Bracket access: client methods are the route names verbatim, and a
  // kebab name isn't a valid identifier. ACTION_NAME_RE admits no quotes.
  const where = method === 'GET' ? 'query' : 'body';
  return `// Live client state for the ${name} action, generated by add_action.
import { signal } from '@preact/signals-core';
import { createRouteClient } from '@cybermole/app-kit/route-table';
import { routes } from '../routes';

const client = createRouteClient(routes, { base: import.meta.env.BASE_URL });

export const ${camel}Status = signal('— not sent yet —');

export async function ${camel}Go(text: string): Promise<void> {
  ${camel}Status.value = '…';
  const r = await client['${name}']({ params: {}, ${where}: { ${SAMPLE_FIELD} } });
  ${camel}Status.value = r.ok
    ? \`ok: received \${r.data.received}\`
    : \`error: \${r.errorMessage ?? r.errorCode}\`;
}
`;
}

function generatedComponentAstro(slug: string, name: string): string {
  return `---
// The ${name} action's UI (SSR), generated by add_action: the ${slug}-${name}
// host with its controls. The enhancer (${name}.ts, this directory) wires
// them; the store (src/store/${name}.ts) holds the live state.
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
---
<${slug}-${name}>
  <wa-input label="${SAMPLE_FIELD}"></wa-input>
  <wa-button variant="brand">${name}</wa-button>
  <p aria-live="polite">— not sent yet —</p>
</${slug}-${name}>
`;
}

function generatedComponent(slug: string, name: string, camel: string, pascal: string): string {
  return `// The ${name} action's enhancer, generated by add_action: wires the SSR'd
// controls (${pascal}.astro, this directory) to the store
// (src/store/${name}.ts). The directory owns its wa-* halves: wa-client
// first, then the client-side re-imports of what the .astro SSRs.
import '@cybermole/app-kit/wa-client';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { effect } from '@preact/signals-core';
import { defineElement, waValue } from '@cybermole/app-kit/element';
import { ${camel}Go, ${camel}Status } from '../../store/${name}';

defineElement('${slug}-${name}', host => {
  const input = host.querySelector('wa-input');
  const button = host.querySelector('wa-button');
  const out = host.querySelector('p[aria-live]');
  const onClick = (): void => {
    void ${camel}Go(waValue(input));
  };
  button?.addEventListener('click', onClick);
  const dispose = effect(() => {
    if (out !== null) out.textContent = ${camel}Status.value;
  });
  // Full teardown: listeners off too, or a re-parented host double-wires.
  return () => {
    button?.removeEventListener('click', onClick);
    dispose();
  };
});
`;
}

// ---------- page marker blocks ----------

export const IMPORT_BEGIN =
  '// BEGIN ACTION IMPORTS (generated — add_action appends one import per action)';
export const IMPORT_END = '// END ACTION IMPORTS';
export const MOUNT_BEGIN =
  '<!-- BEGIN ACTION MOUNTS (generated — add_action appends one element section per action) -->';
export const MOUNT_END = '<!-- END ACTION MOUNTS -->';
export const ENHANCER_BEGIN =
  '// BEGIN ACTION ENHANCERS (generated — add_action appends one import per action)';
export const ENHANCER_END = '// END ACTION ENHANCERS';

function generatedComponentImport(pascal: string): string {
  return `import ${pascal} from '../components/${pascal}/${pascal}.astro';\n`;
}

function generatedPageMount(pascal: string): string {
  return `        <${pascal} />\n`;
}

function generatedEnhancerImport(pascal: string, name: string): string {
  return `      import '../components/${pascal}/${name}';\n`;
}

export interface PageInsert {
  text: string;
  /** markers were absent; a fresh block was appended */
  appendedFresh: boolean;
}

/** Insert before the END marker, on its own line — the marker keeps its
 *  indentation instead of donating it to the insertion. */
function insertBeforeMarkerLine(page: string, endMarker: string, insertion: string): string {
  const end = page.indexOf(endMarker);
  const lineStart = page.lastIndexOf('\n', end) + 1;
  return `${page.slice(0, lineStart)}${insertion}${page.slice(lineStart)}`;
}

/** Without markers (a diverged page), appends a fresh block inside the
 *  frontmatter, before its closing fence. */
function insertIntoImportBlock(page: string, line: string): PageInsert {
  const begin = page.indexOf(IMPORT_BEGIN);
  const end = page.indexOf(IMPORT_END);
  if (begin >= 0 && end > begin) {
    return { text: insertBeforeMarkerLine(page, IMPORT_END, line), appendedFresh: false };
  }
  const fresh = `${IMPORT_BEGIN}\n${line}${IMPORT_END}\n`;
  const fences = [...page.matchAll(/^---[ \t]*$/gm)];
  if (fences.length >= 2) {
    const closing = fences[1]!.index ?? 0;
    return {
      text: `${page.slice(0, closing)}${fresh}${page.slice(closing)}`,
      appendedFresh: true,
    };
  }
  return { text: `---\n${fresh}---\n${page}`, appendedFresh: true };
}

/** Without markers (a diverged page), appends a fresh block before </main>. */
function insertIntoMountBlock(page: string, section: string): PageInsert {
  const begin = page.indexOf(MOUNT_BEGIN);
  const end = page.indexOf(MOUNT_END);
  if (begin >= 0 && end > begin) {
    return {
      text: insertBeforeMarkerLine(page, MOUNT_END, section),
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

function insertIntoEnhancerBlock(page: string, line: string): PageInsert {
  const begin = page.indexOf(ENHANCER_BEGIN);
  const end = page.indexOf(ENHANCER_END);
  if (begin >= 0 && end > begin) {
    return {
      text: insertBeforeMarkerLine(page, ENHANCER_END, line),
      appendedFresh: false,
    };
  }
  const scriptEnd = page.lastIndexOf('</script>');
  const fresh = `      ${ENHANCER_BEGIN}\n${line}      ${ENHANCER_END}\n`;
  if (scriptEnd >= 0) {
    return {
      text: `${page.slice(0, scriptEnd)}${fresh}${page.slice(scriptEnd)}`,
      appendedFresh: true,
    };
  }
  return { text: `${page}\n${fresh}`, appendedFresh: true };
}

// ---------- generator ----------

/** Never throws, never overwrites, never builds. */
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
  // One line by contract: a newline would break the generated literal.
  const summary = (input.summary ?? '').replace(/\s+/g, ' ').trim() || generatedSummary(name);
  const method = input.method ?? 'POST';

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
    path.join('src', 'components', pascal),
    // the pre-directory shapes: a hand-flattened tree would otherwise get
    // a fresh directory written beside the stale flat file
    path.join('src', 'components', `${name}.ts`),
    path.join('src', 'components', `${pascal}.astro`),
    path.join('src', 'store', `${name}.ts`),
  ].filter(rel => fs.existsSync(path.join(tree, rel)));
  if (collisions.length > 0) {
    return fail(
      'artifact_exists',
      `${collisions.join(', ')} already exist but the route table has no ${JSON.stringify(name)} action — a hand-diverged tree; resolve by hand (the generator never overwrites)`,
    );
  }

  try {
    // 1. The domain module, before the entry imports it.
    fs.writeFileSync(
      path.join(tree, 'src', 'lib', `${name}.ts`),
      generatedLib(name, camel, pascal),
    );
    data.written.push({
      file: `src/lib/${name}.ts`,
      what: 'the action’s Result family — a working echo stub (replace with real logic; its tests grow with it)',
    });

    // 2. The table entry and its import (after the last import).
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

    // 3. The test stub; the tree's tests/*.test.mjs glob picks it up.
    fs.writeFileSync(path.join(tree, 'tests', `${name}.test.mjs`), generatedTest(name, camel));
    data.written.push({
      file: `tests/${name}.test.mjs`,
      what: 'the unit-test stub (one test per error code) — the tree’s test glob runs it as-is',
    });

    // 4. The store + the component directory, and the page wiring for them.
    fs.mkdirSync(path.join(tree, 'src', 'store'), { recursive: true });
    fs.writeFileSync(
      path.join(tree, 'src', 'store', `${name}.ts`),
      generatedStore(name, camel, method),
    );
    data.written.push({
      file: `src/store/${name}.ts`,
      what: 'the action’s store — its status signal + the typed-client call',
    });
    fs.mkdirSync(path.join(tree, 'src', 'components', pascal), { recursive: true });
    fs.writeFileSync(
      path.join(tree, 'src', 'components', pascal, `${pascal}.astro`),
      generatedComponentAstro(input.slug, name),
    );
    data.written.push({
      file: `src/components/${pascal}/${pascal}.astro`,
      what: `the action’s SSR component — the ${input.slug}-${name} host with its controls (the .astro half of the component directory)`,
    });
    fs.writeFileSync(
      path.join(tree, 'src', 'components', pascal, `${name}.ts`),
      generatedComponent(input.slug, name, camel, pascal),
    );
    data.written.push({
      file: `src/components/${pascal}/${name}.ts`,
      what: 'the action’s enhancer — an HTML web component wiring the SSR’d controls to the store (the directory’s TS half)',
    });
    const pagePath = path.join(tree, 'src', 'pages', 'index.astro');
    if (fs.existsSync(pagePath)) {
      const page = fs.readFileSync(pagePath, 'utf8');
      const withImport = insertIntoImportBlock(page, generatedComponentImport(pascal));
      const withMount = insertIntoMountBlock(withImport.text, generatedPageMount(pascal));
      const withEnhancer = insertIntoEnhancerBlock(
        withMount.text,
        generatedEnhancerImport(pascal, name),
      );
      fs.writeFileSync(pagePath, withEnhancer.text);
      if (withImport.appendedFresh)
        data.notes.push(
          'src/pages/index.astro had no ACTION IMPORTS markers — a fresh marked block was inserted in the frontmatter (the page diverged from the scaffold shape)',
        );
      if (withMount.appendedFresh)
        data.notes.push(
          'src/pages/index.astro had no ACTION MOUNTS markers — a fresh marked block was appended (the page diverged from the scaffold shape)',
        );
      if (withEnhancer.appendedFresh)
        data.notes.push(
          'src/pages/index.astro had no ACTION ENHANCERS markers — a fresh marked block was appended in the client script',
        );
      data.written.push({
        file: 'src/pages/index.astro',
        what: 'the action’s component import + mount + enhancer import inside the generated markers',
      });
    } else {
      data.notes.push(
        'src/pages/index.astro not found — the store + component directory were written, but no page wiring was added; wire it by hand',
      );
    }

    // 5. AGENTS.md, regenerated from the table as written on disk.
    const agentsPath = path.join(tree, 'AGENTS.md');
    const agentsText = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
    const regen = regenerateAgentsActions(
      agentsText,
      input.slug,
      parseRouteTableSource(fs.readFileSync(routesPath, 'utf8')),
      deps.base ?? '/',
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
    `check — the check tool (slug ${input.slug}): the gate (typecheck + the architecture lint + the grown unit tests + the build that emits dist/route-table.json with the action)`,
    `build — the build tool alone, when only the dist/ artifacts are wanted`,
    `reload — the reload tool: serve the new build (once the app is registered)`,
  ];
  return {
    ok: true,
    resultType: 'add_action',
    data,
  } satisfies AddActionSuccess;
}
