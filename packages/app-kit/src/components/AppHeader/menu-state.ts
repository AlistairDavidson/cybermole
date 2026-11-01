// The header's and SideNav's one read of the console's state: GET
// /api/state, narrowed to the slices the menus show.
import { parseMenuState, type MenuState } from '../../app-menu';

/** null: a network error or an answer that isn't a state. */
export async function fetchMenuState(base: string): Promise<MenuState | 'signed-out' | null> {
  try {
    const response = await fetch(`${base}/api/state`);
    if (response.status === 401) return 'signed-out';
    return parseMenuState(await response.json());
  } catch {
    return null;
  }
}
