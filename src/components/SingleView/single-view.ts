// <single-view>: the /view page body — exactly one pane (a terminal or a
// workspace's editor) with none of the console chrome. view.astro resolves
// the target and renders the pane; this wires it: the <agent-terminal>
// attaches (the same WS attach the console uses, so a dead session
// respawns at the workspace cwd, and a page close just detaches — the tmux
// session keeps running), and the editor iframe follows colour-mode flips.
import { asTerminalId, UUID_RE } from '@cybermole/app-kit';
import { armEditorThemeReload } from '../editor-pane';
import type { AgentTerminal } from '../AgentTerminal/agent-terminal';
import '../AgentTerminal/agent-terminal';

export class SingleView extends HTMLElement {
  private wired = false;

  connectedCallback(): void {
    if (this.wired) return;
    this.wired = true;
    const kind = this.getAttribute('kind');
    if (kind === 'terminal') {
      const pane = this.querySelector<AgentTerminal & HTMLElement>('agent-terminal');
      const raw = this.getAttribute('target') ?? '';
      if (!pane || !UUID_RE.test(raw)) return; // the page only emits resolved uuids
      const id = asTerminalId(raw);
      pane.attach('terminal', id, `terminal:${id}`);
      // Already popped out: the pane toolbar's own pop-out has nowhere to go.
      pane.toolbar?.querySelector('.tb-pop-out')?.classList.add('hidden');
    } else if (kind === 'editor') {
      armEditorThemeReload();
    }
  }
}

if (!customElements.get('single-view')) customElements.define('single-view', SingleView);
