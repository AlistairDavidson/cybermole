// apps-scaffold.ts — the scaffold half of the cybermole-apps MCP
// (task/app-scaffold, docs/plans/apps-plan.md §6): create a real app tree at
// the apps root from the image's app-starter template — slug derived like
// the console's (normalizeSlug), base '/apps/<slug>' baked, node_modules
// as per-package symlinks (§5), a git repo whose first commit is the
// scaffold (agent undo is git clean — one history to roll back to), and
// the operator's AGENTS.md seeded from apps-agent-template/ (§7). This
// module OWNS the tree-writing; the MCP owns the sockets and the tool
// shapes. All fs through this one boundary (CODE_STYLE §2): a failure is
// a Result, never a throw.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeSlug, type ResultFailure, type ResultSuccess } from '@cybermole/app-kit';
import { CommandNotFoundError, type ChildRun, type RunChildFn } from './apps-child';

export interface ScaffoldAppInput {
  name: string;
  description?: string | undefined;
}

export type ScaffoldAppData = {
  /** the derived, stable mount identity (apps-plan §2) */
  slug: string;
  /** the tree's absolute path */
  tree: string;
  /** node_modules per-package links were created (the setup script ran green) */
  linked: boolean;
  /** the git repo was initialized and the scaffold committed */
  committed: boolean;
  /** the build loop's next steps, in order (§1) — the answer carries them
   *  so the model does not have to remember them */
  next: string[];
};
export type ScaffoldAppErrorCode =
  | 'invalid_name'
  | 'tree_exists'
  | 'template_missing'
  | 'write_failed'
  | 'links_failed'
  | 'git_missing'
  | 'git_failed';
export type ScaffoldAppSuccess = ResultSuccess<'scaffold_app', ScaffoldAppData>;
export type ScaffoldAppFailure = ResultFailure<
  'scaffold_app',
  ScaffoldAppData,
  ScaffoldAppErrorCode
>;
export type ScaffoldAppResult = ScaffoldAppSuccess | ScaffoldAppFailure;

export interface ScaffoldDeps {
  /** the apps root (env.ts readAppsRoot) */
  appsRoot: string;
  /** the app-starter template dir shipped in the image */
  templateDir: string;
  /** apps-agent-template/AGENTS.md — the operator-manual template (§7) */
  agentTemplateFile: string;
  /** the cybermole install root (its node_modules is what the links
   *  point into; its dist-server carries the app MCP shim) */
  installRoot: string;
  /** the child runner (injectable; apps-child.runChild is the real one) */
  run: RunChildFn;
}

/** The values every __APP_*__ / __INSTALL_ROOT__ marker in the template
 *  substitutes to. The markers appear only in text files the template
 *  owns; the walk below substitutes exactly these, nothing else. */
export function templateValues(
  input: ScaffoldAppInput & { slug: string },
  installRoot: string,
): {
  [marker: string]: string;
} {
  return {
    __APP_SLUG__: input.slug,
    __APP_NAME__: input.name,
    __APP_DESCRIPTION__: input.description?.trim() ?? '',
    __APP_MCP_SHIM__: path.join(installRoot, 'dist-server', 'server', 'app-mcp-shim.js'),
    __INSTALL_ROOT__: installRoot,
  };
}

const fail = (errorCode: ScaffoldAppErrorCode, errorMessage: string): ScaffoldAppFailure => ({
  ok: false,
  resultType: 'scaffold_app',
  errorCode,
  errorMessage,
});

/** Copy the template and substitute: every text file under the tree gets
 *  the marker values replaced verbatim (a file without markers passes
 *  through byte-identical; the vendored renderer never carries them).
 *  app.json is then COMPOSED (not substituted): JSON needs real quoting,
 *  and an absent description becomes null there — the honest manifest. */
function writeTree(
  deps: ScaffoldDeps,
  tree: string,
  input: ScaffoldAppInput & { slug: string },
): void {
  fs.cpSync(deps.templateDir, tree, { recursive: true });
  const values = templateValues(input, deps.installRoot);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      const original = fs.readFileSync(p, 'utf8');
      let text = original;
      for (const [marker, value] of Object.entries(values)) {
        if (text.includes(marker)) text = text.split(marker).join(value);
      }
      if (text !== original) fs.writeFileSync(p, text);
    }
  };
  walk(tree);
  const description = input.description?.trim();
  fs.writeFileSync(
    path.join(tree, 'app.json'),
    `${JSON.stringify(
      { name: input.name, description: description ? description : null, slug: input.slug },
      null,
      2,
    )}\n`,
  );
}

/** Seed the tree's AGENTS.md from apps-agent-template/AGENTS.md with the
 *  same marker substitution — the root-agents only-where-absent policy
 *  does not apply here: the scaffold OWNS this file's birth (branch 5's
 *  add_action regenerates its actions section; §7). */
function writeAgentsMd(
  deps: ScaffoldDeps,
  tree: string,
  input: ScaffoldAppInput & { slug: string },
): void {
  const template = fs.readFileSync(deps.agentTemplateFile, 'utf8');
  let text = template;
  for (const [marker, value] of Object.entries(templateValues(input, deps.installRoot))) {
    if (text.includes(marker)) text = text.split(marker).join(value);
  }
  fs.writeFileSync(path.join(tree, 'AGENTS.md'), text);
}

/** Scaffold one app tree. Never throws: every failure is a Result. The
 *  git identity is scaffold-local (-c flags — no global config assumed;
 *  the agent's own commits later use whatever identity the tree's owner
 *  configures). */
export async function scaffoldApp(
  deps: ScaffoldDeps,
  input: ScaffoldAppInput,
): Promise<ScaffoldAppResult> {
  const name = input.name.trim();
  const slug = normalizeSlug(name);
  if (slug === '') {
    return fail(
      'invalid_name',
      `the name ${JSON.stringify(input.name)} normalizes to an empty slug — give the app a name with letters or digits`,
    );
  }
  const tree = path.join(deps.appsRoot, slug);
  const data: ScaffoldAppData = {
    slug,
    tree,
    linked: false,
    committed: false,
    next: [
      `check it green: the check tool (slug ${slug})`,
      `register the row: the register tool (writes the db row; the tree already exists)`,
      'reload the host: the reload tool (register + reload is the sync point)',
    ],
  };
  try {
    if (fs.existsSync(tree)) {
      return fail(
        'tree_exists',
        `a tree already exists at ${tree} — scaffold never overwrites; pick another name, or work in the existing tree (status shows it)`,
      );
    }
    if (!fs.existsSync(deps.templateDir)) {
      return fail(
        'template_missing',
        `the app-starter template is missing (${deps.templateDir}) — this cybermole install is broken; nothing was written`,
      );
    }
    if (!fs.existsSync(deps.agentTemplateFile)) {
      return fail(
        'template_missing',
        `the apps-agent-template is missing (${deps.agentTemplateFile}) — this cybermole install is broken; nothing was written`,
      );
    }
    fs.mkdirSync(deps.appsRoot, { recursive: true });
    writeTree(deps, tree, { ...input, name, slug });
    writeAgentsMd(deps, tree, { ...input, name, slug });
  } catch (err) {
    return fail('write_failed', `could not write the tree at ${tree}: ${(err as Error).message}`);
  }

  // The per-package node_modules links — the template's own script, run in
  // the tree (the app can re-run it after an image upgrade; §5).
  try {
    const run = await deps.run('node', ['scripts/setup-node-modules.mjs'], {
      cwd: tree,
      timeoutMs: 60_000,
    });
    if (run.code !== 0) {
      return {
        ...fail(
          'links_failed',
          `the node_modules links could not be created — re-run \`npm run setup\` in ${tree}`,
        ),
        data,
      };
    }
    data.linked = true;
  } catch (err) {
    if (err instanceof CommandNotFoundError) {
      return {
        ...fail(
          'links_failed',
          `node is not runnable (${err.message}) — nothing but the tree was written`,
        ),
        data,
      };
    }
    return { ...fail('links_failed', `the setup script failed: ${(err as Error).message}`), data };
  }

  // The git repo: init + the scaffold commit (agent undo is git clean).
  try {
    const git = (args: string[]): Promise<ChildRun> =>
      deps.run('git', args, { cwd: tree, timeoutMs: 60_000 });
    await git(['init', '-b', 'main']);
    await git(['add', '-A']);
    await git([
      '-c',
      'user.name=cybermole-apps',
      '-c',
      'user.email=cybermole-apps@localhost',
      'commit',
      '-q',
      '-m',
      `scaffold ${slug} from the cybermole app-starter template`,
    ]);
    data.committed = true;
  } catch (err) {
    if (err instanceof CommandNotFoundError) {
      return {
        ...fail(
          'git_missing',
          'git is not on PATH — the tree and its node_modules links were written, but no git repo (agent undo needs one); install git and run `git init && git add -A && git commit` in the tree',
        ),
        data,
      };
    }
    return {
      ...fail('git_failed', `git could not initialize the repo: ${(err as Error).message}`),
      data,
    };
  }

  return {
    ok: true,
    resultType: 'scaffold_app',
    data,
  } satisfies ScaffoldAppSuccess;
}
