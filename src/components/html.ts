/** For client-side innerHTML renders (Astro escapes server-side). */
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

/** setHTMLUnsafe keeps declarative shadow DOM, so SSR'd wa-* hydrate;
 *  innerHTML (the fallback) would leave the shadow templates inert. */
export function parseServerHTML(html: string): Node[] {
  const box = document.createElement('div');
  if (typeof box.setHTMLUnsafe === 'function') box.setHTMLUnsafe(html);
  else box.innerHTML = html;
  return [...box.childNodes];
}
