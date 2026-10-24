// apps-status.ts — the status half of the cybermole-apps MCP
// (task/app-scaffold, docs/apps-plan.md §6): the JOIN the status tool
// answers — every app as one row of REGISTERED (the internal API's rows)
// × MOUNTED (the app host's /_admin/status) × BUILD-STALE (an mtime walk:
// sources newer than the build artifacts), plus the UNREGISTERED TREES
// present at the apps root (manifest + build, no row — plan §2's
// scaffolded-not-yet-registered state). This module is pure fs+data: the
// rows and the host status arrive as inputs (the MCP fetches them over
// the sockets; transport failures are isError results there), so the
// join is unit-testable against synthetic trees and a stub host's answer.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** One app row as GET /apps answers it (the internal API's shape). */
export interface StatusAppRow {
  id: string;
  name: string;
  slug: string;
  cwd: string | null;
}

/** The host status's relevant half (GET /_admin/status on the apps
 *  socket — server/app-host.ts AppHostStatus, trimmed to what the join
 *  reads). */
export interface StatusHostAnswer {
  booted: boolean;
  mounted: Array<{ slug: string }>;
  skipped: Array<{ slug: string; reason: string }>;
}

export interface AppStatusEntry {
  slug: string;
  /** the manifest's name (the row's name when there is no manifest) */
  name: string | null;
  registered: boolean;
  /** the tree the row's cwd names, or <appsRoot>/<slug> when one exists there */
  tree: string | null;
  /** the tree has a manifest (app.json) — a registered row without one is
   *  a console-era grouping row, not an app */
  hasManifest: boolean;
  /** dist/server/entry.mjs exists — the build half of "row + manifest +
   *  build is what mounts" (§3) */
  built: boolean;
  /** sources are newer than the build artifacts (null when not built) */
  buildStale: boolean | null;
  mounted: boolean;
  /** why it is NOT serving, when it is not — the host's own skip reason
   *  for registered apps, the missing piece for everything else */
  servingReason: string | null;
}

export type AppsStatusData = {
  appsRoot: string;
  apps: AppStatusEntry[];
  /** trees at the apps root with NO row — §6's "unregistered trees
   *  present" (register + reload makes them live) */
  unregisteredTrees: string[];
};

/** Files whose mtimes speak for the sources (walked recursively); the
 *  build stamp is the OLDER of the entry and route-table.json — a build
 *  is fresh only when BOTH artifacts postdate every source. */
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
        /* raced away — the walk stays total */
      }
    }
  }
  return Math.max(newest, stat.mtimeMs);
}

/** One tree's fs facts: manifest name, built, stale. Total — a
 *  half-deleted tree answers honestly (no manifest, not built). */
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
    /* no manifest or unreadable — answered below */
  }
  const stamps = BUILD_ARTIFACTS.map(rel => {
    try {
      return fs.statSync(path.join(tree, rel)).mtimeMs;
    } catch {
      return -1;
    }
  });
  const built = stamps[0]! >= 0; // entry.mjs is the build's own product
  const buildStamp = Math.min(...stamps);
  let sources = 0;
  for (const rel of SOURCE_DIRS)
    sources = Math.max(sources, newestMtime(path.join(tree, rel), WALK_SKIP));
  for (const rel of SOURCE_FILES) {
    try {
      sources = Math.max(sources, fs.statSync(path.join(tree, rel)).mtimeMs);
    } catch {
      /* absent — nothing to compare */
    }
  }
  return {
    hasManifest,
    name,
    built,
    buildStale: built ? sources > buildStamp : null,
  };
}

/** The app trees at the apps root: directories with an app.json (the
 *  manifest is what makes a directory an app tree — §2). Sorted by slug. */
export function collectTrees(appsRoot: string): Map<string, string> {
  const trees = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appsRoot, { withFileTypes: true });
  } catch {
    return trees; // a missing root answers "no trees" — scaffold creates it
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const tree = path.join(appsRoot, entry.name);
    if (fs.existsSync(path.join(tree, 'app.json'))) trees.set(entry.name, tree);
  }
  return trees;
}

/** The join (pure). Rows and trees both contribute; a row whose cwd is
 *  outside the apps root still reports against ITS tree (registration is
 *  by row, not by location). */
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
