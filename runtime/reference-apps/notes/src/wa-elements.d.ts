// Web Awesome controls the enhancers reach by tag selector: the tag map
// types plain tag queries, and WaValueHost is the .value the editor writes
// when it clears the create form (the kit's waValue is the reading half).
// Declarations only, no code.
export {};

export interface WaValueHost extends HTMLElement {
  value: string | null;
}

declare global {
  interface HTMLElementTagNameMap {
    'wa-input': WaValueHost;
    'wa-textarea': WaValueHost;
  }
}
