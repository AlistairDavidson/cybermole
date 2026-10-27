// The editor pane's mounting halves, shared by the console's editor tab
// and /view's single-workspace page, so both build the workbench iframe the
// same way.
import { BASE } from '../base';

/** No theme param: the workbench only reads folder/workspace/ew from the
 *  URL. It follows the browser's scheme at boot instead, so a mode flip
 *  reloads the iframe. */
export const editorSrc = (cwd: string): string =>
  `${BASE}/editor/?folder=${encodeURIComponent(cwd)}`;

// On a colour-mode flip, reload any editor pane (re-assigning src reloads)
// so the workbench boots in the new mode. Its own live re-theming is
// unreliable. Only scroll position is lost.
let editorThemeArmed = false;
export function armEditorThemeReload(): void {
  if (editorThemeArmed) return;
  editorThemeArmed = true;
  new MutationObserver(() => {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe.editor-frame'))
      frame.src = frame.src; // eslint-disable-line no-self-assign -- a reload, on purpose
  }).observe(document.documentElement, { attributeFilter: ['class'], attributes: true });
}
