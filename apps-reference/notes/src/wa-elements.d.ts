// wa-elements.d.ts — the Web Awesome elements this app uses inside preact
// islands, declared on preact's JSX namespace (preact knows nothing about
// wa-* custom elements by default; every element an island renders needs
// an entry here — copy the shape from the element's docs/usage in the
// webawesome package). The console never needs this (it renders wa-* in
// .astro files); islands are where JSX meets the web components.
import 'preact';

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'wa-input': preact.JSX.HTMLAttributes<HTMLElement> & {
        label?: string;
        value?: string;
      };
      'wa-textarea': preact.JSX.HTMLAttributes<HTMLElement> & {
        label?: string;
        value?: string;
      };
      'wa-button': preact.JSX.HTMLAttributes<HTMLElement> & {
        variant?: string;
      };
    }
  }
}
