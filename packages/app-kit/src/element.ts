// The HTML web component convention (CODE_STYLE.md §7): the page SSRs real
// light-DOM children inside the custom element, and the enhancer wires them
// from connectedCallback. Enhance, never render — no shadow DOM, no
// client-side initial content. defineElement carries the guard and the
// lifecycle so every enhancer gets them right by construction.

/** Declare an enhancer element. `setup` runs on first connect with the host;
 *  return a teardown and it runs on disconnect (effect()'s disposer is
 *  exactly that). A setup that wires listeners without a teardown will
 *  double-wire if the element is moved in the DOM — always return one. */
export function defineElement(
  name: string,
  setup: (host: HTMLElement) => void | (() => void),
): void {
  if (customElements.get(name) !== undefined) return;
  customElements.define(
    name,
    class extends HTMLElement {
      #teardown: (() => void) | undefined;
      connectedCallback(): void {
        if (this.#teardown !== undefined) return;
        const teardown = setup(this);
        this.#teardown = teardown ?? ((): void => undefined);
      }
      disconnectedCallback(): void {
        this.#teardown?.();
        this.#teardown = undefined;
      }
    },
  );
}

/** A wa-* control's value, '' for null (an un-upgraded wa-input's .value is
 *  null, not '' — the empty string keeps handlers simple). */
export function waValue(element: Element | null): string {
  const value = (element as { value?: unknown } | null)?.value;
  return value === null || value === undefined ? '' : String(value);
}
