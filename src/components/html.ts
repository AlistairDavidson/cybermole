// html.ts — the two client-side HTML helpers the components share.

/** Escape text for an HTML string (the console's and sidebar's
 *  innerHTML renders — the server-rendered pages need none of this:
 *  Astro escapes). */
export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] as string,
  );
}

/** Parse a server-rendered fragment (a /partials/* answer) into nodes.
 *  setHTMLUnsafe keeps declarative shadow DOM, so SSR'd wa-* elements
 *  arrive with their shadow roots and hydrate like on first load —
 *  innerHTML would drop the <template shadowrootmode> into the light DOM
 *  (the fallback, for browsers without setHTMLUnsafe: the elements then
 *  render fresh, the inert template stays invisible). */
export function parseServerHTML(html: string): Node[] {
  const box = document.createElement('div');
  if (typeof box.setHTMLUnsafe === 'function') box.setHTMLUnsafe(html);
  else box.innerHTML = html;
  return [...box.childNodes];
}
