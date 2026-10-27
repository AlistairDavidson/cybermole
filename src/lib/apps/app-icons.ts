// The app icon registry: the pickable icon names, exactly the vendored Web
// Awesome solid glyphs (public/icons/wa/solid — the CSP has no CDN, so a
// name outside this list has nothing to render). Node-free on purpose: the
// server validates with it, the scaffold and MCP tools describe it, the
// sidebar/builder render from it, and the settings page's picker lists it.

/** What an app row shows when its icon is unset (db NULL). */
export const DEFAULT_APP_ICON = 'cubes';

/** The pickable icons, in picker order. */
export const APP_ICONS = [
  'cubes',
  'file-lines',
  'code',
  'robot',
  'terminal',
  'folder',
  'gear',
  'clock',
  'play',
  'download',
  'magnifying-glass',
  'pencil',
  'copy',
  'circle-check',
  'circle-info',
  'triangle-exclamation',
  'eye',
  'eye-slash',
  'arrows-rotate',
  'rotate-right',
] as const;

export type AppIcon = (typeof APP_ICONS)[number];

const APP_ICON_SET: ReadonlySet<string> = new Set(APP_ICONS);

/** The error message's canonical list — shared by every invalid_icon answer. */
export const APP_ICON_NAMES = APP_ICONS.join(', ');

export function isAppIcon(raw: string): raw is AppIcon {
  return APP_ICON_SET.has(raw);
}

// ---------- the suggestion rule ----------

/** First keyword whose word-prefix matches wins (boring on purpose). */
const SUGGESTIONS: ReadonlyArray<readonly [keyword: string, AppIcon]> = [
  ['note', 'file-lines'],
  ['memo', 'file-lines'],
  ['journal', 'file-lines'],
  ['doc', 'file-lines'],
  ['wiki', 'file-lines'],
  ['code', 'code'],
  ['dev', 'code'],
  ['agent', 'robot'],
  ['bot', 'robot'],
  ['ai', 'robot'],
  ['terminal', 'terminal'],
  ['shell', 'terminal'],
  ['console', 'terminal'],
  ['cli', 'terminal'],
  ['job', 'clock'],
  ['cron', 'clock'],
  ['schedule', 'clock'],
  ['time', 'clock'],
  ['search', 'magnifying-glass'],
  ['find', 'magnifying-glass'],
  ['edit', 'pencil'],
  ['write', 'pencil'],
  ['draw', 'pencil'],
  ['copy', 'copy'],
  ['clone', 'copy'],
  ['download', 'download'],
  ['fetch', 'download'],
  ['play', 'play'],
  ['media', 'play'],
  ['music', 'play'],
  ['video', 'play'],
  ['file', 'folder'],
  ['folder', 'folder'],
  ['archive', 'folder'],
  ['setting', 'gear'],
  ['config', 'gear'],
  ['check', 'circle-check'],
  ['health', 'circle-check'],
  ['monitor', 'circle-check'],
  ['info', 'circle-info'],
  ['alert', 'triangle-exclamation'],
  ['warn', 'triangle-exclamation'],
  ['watch', 'eye'],
  ['observe', 'eye'],
  ['sync', 'arrows-rotate'],
  ['update', 'arrows-rotate'],
  ['refresh', 'arrows-rotate'],
];

/** A keyword matches when a whole word of the name starts with it, so
 *  "chair" never suggests via "ai". Unmatched names get the default. */
export function suggestAppIcon(name: string): AppIcon {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 0);
  for (const [keyword, icon] of SUGGESTIONS) {
    if (words.some(w => w.startsWith(keyword))) return icon;
  }
  return DEFAULT_APP_ICON;
}
