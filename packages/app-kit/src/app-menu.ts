// The header's Apps menu, decided from the console's state JSON (GET
// /api/state): which apps it lists, in what order, and where each item goes.
// Node-free and DOM-free, so unit tests run it straight from dist-server.
import { z } from 'zod';

const MenuStateSchema = z.object({
  /** CYBERMOLE_GRAFANA_URL is set: the header shows its logs link. */
  logs: z.boolean(),
  apps: z.array(
    z.object({
      name: z.string(),
      slug: z.string(),
      icon: z.string(),
      order: z.number(),
      serving: z.boolean(),
    }),
  ),
});

export type MenuState = z.infer<typeof MenuStateSchema>;

export interface AppMenuEntry {
  slug: string;
  name: string;
  icon: string;
  href: string;
  /** false: the app host isn't serving it — listed, but not selectable. */
  serving: boolean;
}

/** The slices of a state answer the header reads, else null (not a state). */
export function parseMenuState(json: unknown): MenuState | null {
  const parsed = MenuStateSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** `base`: the console's base, '' at the site root. Console order. */
export function appMenuEntries(apps: MenuState['apps'], base: string): AppMenuEntry[] {
  return [...apps]
    .sort((a, b) => a.order - b.order)
    .map(a => ({
      slug: a.slug,
      name: a.name,
      icon: a.icon,
      href: `${base}/apps/${a.slug}/`,
      serving: a.serving,
    }));
}

/** An app's page bakes `<console base>/apps/<slug>` as its own base; the
 *  console's base is what precedes it ('' at the site root). */
export function consoleBaseOf(appBase: string): string {
  const trimmed = appBase.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/apps/');
  return i < 0 ? trimmed : trimmed.slice(0, i);
}
