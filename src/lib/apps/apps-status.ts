// The status tool's join: each app as registered (internal API row) ×
// mounted (app host status) × built/stale (an mtime walk), plus trees at the
// apps root that have no row yet. Pure fs and data; the sockets are the
// MCP's job.
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StatusAppRow {
  id: string;
  name: string;
  slug: string;
  cwd: string | null;
}

/** The fields of server/app-host.ts AppHostStatus the join reads. */
export interface StatusHostAnswer {
  booted: boolean;
  mounted: Array<{ slug: string }>;
  skipped: Array<{ slug: string; reason: string }>;
}

export interface AppStatusEntry {
  slug: string;
  /** the manifest's name, else the row's */
  name: string | null;
  registered: boolean;
  tree: string | null;
  /** A registered row without one is a plain console group, not an app. */
  hasManifest: boolean;
  /** dist/server/entry.mjs exists */
  built: boolean;
  /** null when not built */
  buildStale: boolean | null;
  mounted: boolean;
  /** null when serving */
  servingReason: string | null;
}

export type AppsStatusData = {
  appsRoot: string;
  apps: AppStatusEntry[];
  /** trees with app.json but no row */
  unregisteredTrees: string[];
};

/** A build is fresh only when both artifacts postdate every source. */
const SOURCE_DIRS = ['src', 'public'];
const SOURCE_FILES = ['astro.config.mjs', 'package.json', 'tsconfig.json'];
const BUILD_ARTIFACTS = ['dist/server/entry.mjs', 'dist/route-table.json'];
const WALK_SKIP = new Set(['node_modules', 'dist', '.git', 'data', '.astro']);

function newestMtime(root: string, skipDirs: Set<string> | null): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.mtimeMs;
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (skipDirs?.has(entry.name)) continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(child, skipDirs));
    else if (entry.isFile() || entry.isSymbolicLink()) {
      try {
        newest = Math.max(newest, fs.statSync(child).mtimeMs);
      } catch {
        /* raced away */
      }
    }
  }
  return Math.max(newest, stat.mtimeMs);
}

/** Never throws; a half-deleted tree reads as no manifest, not built. */
export function inspectTree(tree: string): {
  hasManifest: boolean;
  name: string | null;
  built: boolean;
  buildStale: boolean | null;
} {
  let name: string | null = null;
  let hasManifest = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(tree, 'app.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof manifest.name === 'string' && manifest.name.trim() !== '') {
      name = manifest.name.trim();
      hasManifest = true;
    }
  } catch {
    /* no manifest */
  }
  const stamps = BUILD_ARTIFACTS.map(rel => {
    try {
      return fs.statSync(path.join(tree, rel)).mtimeMs;
    } catch {
      return -1;
    }
  });
  const built = stamps[0]! >= 0; // entry.mjs
  const buildStamp = Math.min(...stamps);
  let sources = 0;
  for (const rel of SOURCE_DIRS)
    sources = Math.max(sources, newestMtime(path.join(tree, rel), WALK_SKIP));
  for (const rel of SOURCE_FILES) {
    try {
      sources = Math.max(sources, fs.statSync(path.join(tree, rel)).mtimeMs);
    } catch {
      /* absent */
    }
  }
  return {
    hasManifest,
    name,
    built,
    buildStale: built ? sources > buildStamp : null,
  };
}

/** Directories with an app.json, keyed by slug. */
export function collectTrees(appsRoot: string): Map<string, string> {
  const trees = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appsRoot, { withFileTypes: true });
  } catch {
    return trees;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const tree = path.join(appsRoot, entry.name);
    if (fs.existsSync(path.join(tree, 'app.json'))) trees.set(entry.name, tree);
  }
  return trees;
}

/** A row whose cwd is outside the apps root still reports against its own tree. */
export function joinAppsStatus(
  appsRoot: string,
  rows: StatusAppRow[],
  host: StatusHostAnswer,
): AppsStatusData {
  const trees = collectTrees(appsRoot);
  const mountedSlugs = new Set(host.mounted.map(m => m.slug));
  const skippedBySlug = new Map(host.skipped.map(s => [s.slug, s.reason] as const));
  const slugs = new Set<string>([...rows.map(r => r.slug), ...trees.keys()]);
  const apps: AppStatusEntry[] = [...slugs].sort().map(slug => {
    const row = rows.find(r => r.slug === slug) ?? null;
    const tree = trees.get(slug) ?? (row?.cwd && fs.existsSync(row.cwd) ? row.cwd : null);
    const facts = tree !== null ? inspectTree(tree) : null;
    const registered = row !== null;
    const mounted = mountedSlugs.has(slug);
    let servingReason: string | null = null;
    if (!mounted) {
      if (!registered) servingReason = 'not registered — register + reload to serve it';
      else {
        const skip = skippedBySlug.get(slug);
        if (skip !== undefined) servingReason = skip;
        else if (host.booted !== true)
          servingReason =
            'the app host has not finished its first discovery — reload once it boots';
        else if (tree === null)
          servingReason = `the row's tree does not exist (${row?.cwd ?? 'no cwd'})`;
        else servingReason = 'not mounted at the host\u2019s last sync — reload to sync';
      }
    }
    return {
      slug,
      name: facts?.name ?? row?.name ?? null,
      registered,
      tree,
      hasManifest: facts?.hasManifest ?? false,
      built: facts?.built ?? false,
      buildStale: facts?.buildStale ?? null,
      mounted,
      servingReason,
    };
  });
  return {
    appsRoot,
    apps,
    unregisteredTrees: apps.filter(a => !a.registered).map(a => a.slug),
  };
}
