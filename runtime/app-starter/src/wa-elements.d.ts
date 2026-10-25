// Web Awesome elements used in preact islands, declared on preact's JSX
// namespace. Every element an island renders needs an entry here.
import 'preact';

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'wa-input': preact.JSX.HTMLAttributes<HTMLElement> & {
        label?: string;
        value?: string;
      };
      'wa-button': preact.JSX.HTMLAttributes<HTMLElement> & {
        variant?: string;
      };
    }
  }
}
