// <single-view>: the /view page body — exactly one pane (a terminal or a
// workspace's editor) with none of the console chrome. The page resolves
// the target server-side and passes it as attributes; this component mounts
// the same panes the console mounts: <agent-terminal> for a terminal (the
// same WS attach, so a dead session respawns at the workspace cwd, and a
// page close just detaches — the tmux session keeps running), the editor
// iframe for a workspace.
import { asTerminalId, UUID_RE } from '@cybermole/app-kit';
import { armEditorThemeReload, editorSrc } from '../editor-pane';
import type { AgentTerminal } from '../AgentTerminal/agent-terminal';
import '../AgentTerminal/agent-terminal';

export class SingleView extends HTMLElement {
  connectedCallback(): void {
    if (this.childElementCount > 0) return;
    const kind = this.getAttribute('kind');
    if (kind === 'terminal') {
      const raw = this.getAttribute('target') ?? '';
      if (!UUID_RE.test(raw)) return; // the page only emits resolved uuids
      const id = asTerminalId(raw);
      const el = document.createElement('agent-terminal') as AgentTerminal & HTMLElement;
      el.innerHTML = '<div class="terminal-container"></div><div class="terminal-status"></div>';
      this.appendChild(el);
      el.attach('terminal', id, `terminal:${id}`);
      // Already popped out: the pane toolbar's own pop-out has nowhere to go.
      el.toolbar?.querySelector('.tb-pop-out')?.classList.add('hidden');
    } else if (kind === 'editor') {
      armEditorThemeReload();
      const frame = document.createElement('iframe');
      frame.className = 'editor-frame';
      frame.title = this.getAttribute('label') ?? 'editor';
      frame.src = editorSrc(this.getAttribute('cwd') ?? '');
      this.appendChild(frame);
    }
  }
}

if (!customElements.get('single-view')) customElements.define('single-view', SingleView);
