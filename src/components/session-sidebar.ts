// session-sidebar.ts — <session-sidebar>: live sessions + past pi sessions.
// Emits: attach-live {name}, attach-resume {id}, new-session {name},
// hide-session {id, title}, open-zed {cwd} (only rendered when the Zed
// webapp is configured — ConsoleState.zed), manage-hidden (bubbles to
// <console-app>). The whole tree re-renders via innerHTML on the 15s state
// poll: transient input state (new-name value/focus; search value/focus/
// caret) is captured before the swap and re-applied after, and typing only
// re-renders the session list — never a stateful wa-* component lives in
// here (the Zed/hide buttons are stateless wa-buttons, re-created by the
// poll like every other row content).
import type { ActiveKey, ConsoleState, LiveSession, PastSession } from '../lib/types';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import { esc } from './html';

/** <wa-input> surface used by this component (it's form-associated). */
interface WaInputLike extends HTMLElement {
  value: string;
  focus(options?: FocusOptions): void;
  setSelectionRange(start: number, end: number): void;
}

/** Caret offset inside a <wa-input>'s native input (null if unavailable). */
function caretOf(el: WaInputLike): number | null {
  const native = (el as unknown as { input?: HTMLInputElement }).input
    ?? (el.shadowRoot?.querySelector('input') ?? null);
  return native ? native.selectionStart : null;
}

export class SessionSidebar extends HTMLElement {
  private activeKey: ActiveKey | null = null;
  private state: ConsoleState | null = null;
  private search = '';

  render(st: ConsoleState, activeKey: ActiveKey | null): void {
    this.activeKey = activeKey;
    this.state = st;
    // Preserve in-progress typing + focus across the 15s poll re-render.
    const prev = this.querySelector('#new-name') as WaInputLike | null;
    const typing = prev && document.activeElement === prev ? prev.value : null;
    const prevSearch = this.querySelector('#session-search') as WaInputLike | null;
    if (prevSearch) this.search = prevSearch.value;
    const searchFocused = prevSearch !== null && document.activeElement === prevSearch;
    const searchCaret = searchFocused && prevSearch ? caretOf(prevSearch) : null;
    const hiddenCount = st.hiddenCount;
    this.innerHTML = `
      <section class="new-session wa-cluster wa-gap-2xs">
        <wa-input id="new-name" placeholder="new session name" maxlength="30" size="s"></wa-input>
        <wa-button id="new-btn" variant="brand" size="s">
          <wa-icon slot="start" name="plus"></wa-icon>new
        </wa-button>
      </section>
      <nav class="nav">
        <h2>live ${st.live.length ? `<wa-badge pill>${st.live.length}</wa-badge>` : ''}</h2>
        <ul>${st.live.map(s => this.liveItem(s)).join('')}</ul>
        <h2>sessions <wa-badge id="sessions-count" pill>${this.visibleSessions().length}</wa-badge></h2>
        <wa-input id="session-search" class="session-search" placeholder="filter sessions…" size="s">
          <wa-icon slot="start" name="magnifying-glass"></wa-icon>
        </wa-input>
        ${hiddenCount > 0 ? `
        <wa-button id="manage-hidden" class="manage-hidden" appearance="plain" size="xs"
                   data-drawer="close">
          <wa-icon slot="start" name="eye-slash"></wa-icon>${hiddenCount} hidden — manage
        </wa-button>` : ''}
        <ul id="session-list">${this.sessionList(this.visibleSessions())}</ul>
      </nav>`;
    const input = this.querySelector('#new-name') as WaInputLike | null;
    // Restore value immediately (Lit's first render reads the property),
    // but focus/caret only after that render: <wa-input>.focus() and
    // .setSelectionRange() forward to the native input inside the shadow
    // root, which Lit builds on a microtask — synchronously after
    // innerHTML it is still null and the call would throw.
    const restoreFocus = (el: WaInputLike, caret: number | null): void => {
      requestAnimationFrame(() => {
        el.focus();
        if (caret !== null) el.setSelectionRange(caret, caret);
      });
    };
    if (input && typing !== null) { input.value = typing; restoreFocus(input, null); }
    const searchInput = this.querySelector('#session-search') as WaInputLike | null;
    if (searchInput) {
      searchInput.value = this.search;
      if (searchFocused) restoreFocus(searchInput, searchCaret);
    }
    (this.querySelector('#new-btn') as HTMLElement).onclick = () => this.emitNew();
    input?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') this.emitNew(); });
    searchInput?.addEventListener('input', () => {
      this.search = searchInput.value;
      this.updateSessionList();
    });
    searchInput?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.search !== '') {
        searchInput.value = '';
        this.search = '';
        this.updateSessionList();
      }
    });
    (this.querySelector('#manage-hidden') as HTMLElement | null)?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('manage-hidden', { bubbles: true, composed: true }));
    });
    this.querySelectorAll<HTMLElement>('[data-live]').forEach(el => {
      el.onclick = () => this.dispatchEvent(new CustomEvent('attach-live', {
        detail: el.dataset.live, bubbles: true, composed: true,
      }));
    });
    this.querySelectorAll<HTMLElement>('[data-resume]').forEach(el => {
      el.onclick = () => this.dispatchEvent(new CustomEvent('attach-resume', {
        detail: el.dataset.resume, bubbles: true, composed: true,
      }));
    });
    this.querySelectorAll<HTMLElement>('[data-hide]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation(); // the row itself resumes; the button hides
        const s = (this.state?.sessions ?? []).find(x => x.id === el.dataset.hide);
        if (s) this.dispatchEvent(new CustomEvent('hide-session', {
          detail: { id: s.id, title: s.title }, bubbles: true, composed: true,
        }));
      };
    });
    this.querySelectorAll<HTMLElement>('[data-zed]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation(); // the row itself attaches/resumes
        if (el.dataset.zed) this.dispatchEvent(new CustomEvent('open-zed', {
          detail: { cwd: el.dataset.zed }, bubbles: true, composed: true,
        }));
      };
    });
  }

  private emitNew(): void {
    const input = this.querySelector('#new-name') as WaInputLike | null;
    const name = input?.value.trim() ?? '';
    if (!name) { input?.focus(); return; }
    if (input) input.value = '';
    this.dispatchEvent(new CustomEvent('new-session', { detail: name, bubbles: true, composed: true }));
  }

  private matchesSearch(s: PastSession): boolean {
    const q = this.search.trim().toLowerCase();
    if (!q) return true;
    return s.title.toLowerCase().includes(q)
      || s.cwd.toLowerCase().includes(q)
      || s.id.toLowerCase().includes(q);
  }

  /** Not-hidden past sessions passing the search filter. */
  private visibleSessions(): PastSession[] {
    return (this.state?.sessions ?? []).filter(s => !s.hidden && this.matchesSearch(s));
  }

  /** Re-render just the filtered list + count (keeps the search box's
   *  focus/caret untouched while typing — only the poll swaps the input). */
  private updateSessionList(): void {
    const ul = this.querySelector('#session-list');
    const badge = this.querySelector('#sessions-count');
    if (ul) ul.innerHTML = this.sessionList(this.visibleSessions());
    if (badge) badge.textContent = String(this.visibleSessions().length);
  }

  private liveItem(s: LiveSession): string {
    const key: ActiveKey = `live:${s.name}`;
    const cls = key === this.activeKey ? ' class="active"' : '';
    const zed = this.state?.zed && s.cwd
      ? `<wa-button class="zed-btn" data-zed="${esc(s.cwd)}" size="xs" ` +
        `appearance="plain" title="open ${esc(s.cwd)} in the Zed webapp">` +
        `<wa-icon name="code" label="open in Zed"></wa-icon></wa-button>`
      : '';
    return `<li${cls} data-live="${esc(s.name)}" data-key="${esc(key)}" data-drawer="close" ` +
      `title="attach to live tmux session (${esc(s.socket)} socket)">` +
      `<span class="t"><wa-icon name="play"></wa-icon><span class="t-name">${esc(s.name)}</span></span>` +
      `<span class="d">${s.windows} win · ${esc(s.created)}${s.attached ? ' · attached' : ''}</span>` + zed + `</li>`;
  }

  private sessionList(list: PastSession[]): string {
    if (!list.length) {
      return this.search.trim()
        ? `<li class="empty">no sessions match “${esc(this.search.trim())}”</li>`
        : '';
    }
    let html = ''; let lastCwd: string | null = null;
    for (const s of list) {
      if (s.cwd !== lastCwd) {
        lastCwd = s.cwd;
        html += `<li class="group"><wa-icon name="folder"></wa-icon>` +
          `<span class="t-name">${esc(s.cwd)}</span></li>`;
      }
      const key: ActiveKey = `resume:${s.id}`;
      const cls = key === this.activeKey ? ' class="active"' : '';
      html += `<li${cls} data-resume="${esc(s.id)}" data-key="${esc(key)}" data-drawer="close" ` +
        `title="resume (pi --session — appends, history preserved)">` +
        `<span class="row-main">` +
        `<span class="t"><span class="t-name">${esc(s.title)}</span></span>` +
        `<span class="d"><wa-relative-time date="${new Date(s.mtime).toISOString()}" format="narrow" sync></wa-relative-time></span>` +
        `</span>` +
        (this.state?.zed
          ? `<wa-button class="zed-btn" data-zed="${esc(s.cwd)}" size="xs" ` +
            `appearance="plain" title="open ${esc(s.cwd)} in the Zed webapp">` +
            `<wa-icon name="code" label="open in Zed"></wa-icon></wa-button>`
          : '') +
        `<wa-button class="hide-btn" data-hide="${esc(s.id)}" size="xs" ` +
        `appearance="plain" title="hide from list (reversible)">` +
        `<wa-icon name="eye-slash" label="hide from list"></wa-icon></wa-button></li>`;
    }
    return html;
  }
}

if (!customElements.get('session-sidebar')) customElements.define('session-sidebar', SessionSidebar);
