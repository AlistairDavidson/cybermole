// Scaffolds an app tree from the app-starter template: slug derived from the
// name, base '<console base>/apps/<slug>' baked in (the console's URL base is
// part of the app's baked URLs, so a subpath console scaffolds subpath apps),
// node_modules as per-package symlinks into the install, AGENTS.md seeded,
// and a git repo whose first commit is the scaffold (so agent undo is
// `git clean`). Never throws.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeSlug, type ResultFailure, type ResultSuccess } from '@cybermole/app-kit';
import { CommandNotFoundError, type ChildRun, type RunChildFn } from './apps-child';
import { APP_ICON_NAMES, isAppIcon, suggestAppIcon } from './app-icons';

export interface ScaffoldAppInput {
  name: string;
  description?: string | undefined;
  /** Absent = suggested from the name; must be a registry name. */
  icon?: string | undefined;
}

export type ScaffoldAppData = {
  /** stable once created */
  slug: string;
  /** the effective icon (given, else suggested from the name) — in app.json,
   *  so register lands it on the row */
  icon: string;
  /** absolute */
  tree: string;
  linked: boolean;
  committed: boolean;
  /** the loop's next steps, so the model needn't remember them */
  next: string[];
};
export type ScaffoldAppErrorCode =
  | 'invalid_name'
  | 'invalid_icon'
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
  appsRoot: string;
  templateDir: string;
  agentTemplateFile: string;
  /** node_modules links point into it; its dist-server has the app MCP shim */
  installRoot: string;
  /** The console's normalized URL base (readBase() shape: '/' at the site
   *  root) — baked into the app's astro config so its URLs live under the
   *  console. Default '/': the site root, as before bases existed. */
  base?: string;
  run: RunChildFn;
}

/** Values for the template's __APP_*__ / __INSTALL_ROOT__ markers. */
export function templateValues(
  input: ScaffoldAppInput & { slug: string },
  installRoot: string,
  /** The console's normalized base (readBase() shape: '/' at the site root). */
  base = '/',
): {
  [marker: string]: string;
} {
  return {
    __APP_SLUG__: input.slug,
    __APP_BASE__: base === '/' ? '' : base,
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

/** Text files get markers replaced verbatim. app.json is composed rather
 *  than substituted, since JSON needs real quoting. */
function writeTree(
  deps: ScaffoldDeps,
  tree: string,
  input: ScaffoldAppInput & { slug: string; icon: string },
): void {
  fs.cpSync(deps.templateDir, tree, { recursive: true });
  // npm pack drops a deeply nested .gitignore, so the template ships it undotted
  if (fs.existsSync(path.join(tree, 'gitignore'))) {
    fs.renameSync(path.join(tree, 'gitignore'), path.join(tree, '.gitignore'));
  }
  const values = templateValues(input, deps.installRoot, deps.base);
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
      {
        name: input.name,
        description: description ? description : null,
        slug: input.slug,
        icon: input.icon,
      },
      null,
      2,
    )}\n`,
  );
}

/** Written unconditionally: the scaffold owns this file's creation. */
function writeAgentsMd(
  deps: ScaffoldDeps,
  tree: string,
  input: ScaffoldAppInput & { slug: string; icon: string },
): void {
  const template = fs.readFileSync(deps.agentTemplateFile, 'utf8');
  let text = template;
  for (const [marker, value] of Object.entries(
    templateValues(input, deps.installRoot, deps.base),
  )) {
    if (text.includes(marker)) text = text.split(marker).join(value);
  }
  fs.writeFileSync(path.join(tree, 'AGENTS.md'), text);
}

/** Git identity is passed with -c, so no global config is assumed. */
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
  const icon = input.icon?.trim() ?? '';
  if (icon !== '' && !isAppIcon(icon)) {
    return fail(
      'invalid_icon',
      `icon must be one of the vendored names: ${APP_ICON_NAMES} — or omit it and the name suggests one`,
    );
  }
  const effectiveIcon = icon === '' ? suggestAppIcon(name) : icon;
  const tree = path.join(deps.appsRoot, slug);
  const data: ScaffoldAppData = {
    slug,
    icon: effectiveIcon,
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
        `the app-agents template is missing (${deps.agentTemplateFile}) — this cybermole install is broken; nothing was written`,
      );
    }
    fs.mkdirSync(deps.appsRoot, { recursive: true });
    writeTree(deps, tree, { ...input, name, slug, icon: effectiveIcon });
    writeAgentsMd(deps, tree, { ...input, name, slug, icon: effectiveIcon });
  } catch (err) {
    return fail('write_failed', `could not write the tree at ${tree}: ${(err as Error).message}`);
  }

  // The template's own script, which the app can re-run after an upgrade.
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
