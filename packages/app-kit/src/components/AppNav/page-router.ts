// PageRouter's client half: in-place navigation between the pages of one
// build. A plain same-tab click on a link to another page of the build
// fetches that page and swaps it into the live shell instead of loading
// it whole. The wa-page and its drawer stay, so the shell never re-lays
// out, and the mobile drawer shuts through wa-page's own hide, the same
// animation as closing it in-page. Only the wa-page's children are
// replaced, minus those marked data-page-persist (the side nav). The
// console and each app are separate builds on the one origin; a swap can
// only stay within a build (another build's page brings its own copies of
// modules this document already ran, the same custom elements defined
// twice), so a link into another build, or a page without the router,
// loads whole.

/** Fired on document before the swap, with the next page's parsed
 *  document: persisted elements take what they need from their copies. */
export const BEFORE_SWAP = 'page-router:before-swap';
export interface BeforeSwapDetail {
  newDocument: Document;
  to: URL;
}

const PERSIST = 'data-page-persist';
/** On a slow load the drawer stops waiting for the next page and shuts. */
const DRAWER_WAIT_MS = 300;

interface ShellPage extends HTMLElement {
  hideNavigation?: () => void;
}

/** 'console', or the slug of the app the path is under; null off the base. */
function buildOf(path: string, base: string): string | null {
  if (path !== base && !path.startsWith(`${base}/`)) return null;
  return /^\/apps\/([^/]+)/.exec(path.slice(base.length))?.[1] ?? 'console';
}

function sameBuild(target: URL): boolean {
  if (target.origin !== location.origin) return false;
  const base = document.querySelector<HTMLElement>('side-nav')?.dataset.base ?? '';
  const here = buildOf(location.pathname, base);
  return here !== null && buildOf(target.pathname, base) === here;
}

function routed(doc: Document): ShellPage | null {
  if (!doc.querySelector('meta[name="page-router"]')) return null;
  return doc.querySelector<ShellPage>('wa-page.app-page');
}

/** The link a click or press on `e` follows in place, or null. */
function routableLink(e: MouseEvent | PointerEvent): URL | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
    return null;
  // composedPath reaches the anchor inside a wa-button's shadow root.
  const origin = e.composedPath()[0];
  const link = origin instanceof Element ? origin.closest('a') : null;
  if (!link?.href || link.hasAttribute('download') || link.hasAttribute('data-page-reload'))
    return null;
  if (link.target && link.target !== '_self') return null;
  const target = new URL(link.href);
  // A fragment of this page is the browser's to scroll to.
  if (target.hash && target.pathname === location.pathname && target.search === location.search)
    return null;
  return sameBuild(target) ? target : null;
}

interface Fetched {
  html: string;
  url: URL;
}

/** The page's HTML, or null when it isn't an HTML page to swap. */
async function fetchPage(to: URL, signal?: AbortSignal): Promise<Fetched | null> {
  try {
    const res = await fetch(to, { signal: signal ?? null, headers: { accept: 'text/html' } });
    const type = (res.headers.get('content-type') ?? '').split(';', 1)[0]?.trim();
    if (type !== 'text/html') return null;
    const url = new URL(res.url);
    url.hash = to.hash;
    return { html: await res.text(), url };
  } catch {
    return null;
  }
}

// A press starts the fetch (a tap's press runs ~100 ms ahead of its click);
// the click picks it up if it is for the same page and still fresh.
let prefetched: { href: string; at: number; page: Promise<Fetched | null> } | null = null;
const PREFETCH_TTL_MS = 5000;

function pageFor(to: URL, signal: AbortSignal): Promise<Fetched | null> {
  const hit = prefetched;
  prefetched = null;
  if (hit?.href === to.href && performance.now() - hit.at < PREFETCH_TTL_MS) return hit.page;
  return fetchPage(to, signal);
}

/** The page with its declarative shadow DOM attached (DOMParser leaves
 *  the templates inert). Not Document.parseHTMLUnsafe: Chromium's drops
 *  comments, Lit's hydration markers among them. */
function parse(html: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const attach = (root: ParentNode): void => {
    for (const template of root.querySelectorAll<HTMLTemplateElement>('template[shadowrootmode]')) {
      const host = template.parentElement;
      const mode = template.getAttribute('shadowrootmode');
      if (!host || (mode !== 'open' && mode !== 'closed') || host.shadowRoot) continue;
      const shadow = host.attachShadow({
        mode,
        delegatesFocus: template.hasAttribute('shadowrootdelegatesfocus'),
      });
      shadow.append(template.content);
      template.remove();
      attach(shadow);
    }
  };
  attach(doc);
  return doc;
}

function loaded(el: HTMLLinkElement | HTMLScriptElement): Promise<void> {
  return new Promise(resolve => {
    el.addEventListener('load', () => resolve(), { once: true });
    el.addEventListener('error', () => resolve(), { once: true });
  });
}

/** The next page's stylesheets and module scripts this document lacks,
 *  loaded before the swap: its elements are defined (and styled) as they
 *  land, never painted un-upgraded. */
async function loadAssets(next: Document): Promise<void> {
  const waits: Promise<void>[] = [];
  const sheets = new Set(
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(l => l.href),
  );
  for (const link of next.querySelectorAll<HTMLLinkElement>('head link[rel="stylesheet"]')) {
    const href = new URL(link.getAttribute('href') ?? '', location.href).href;
    if (sheets.has(href)) continue;
    const fresh = document.importNode(link);
    waits.push(loaded(fresh));
    document.head.append(fresh);
  }
  const scripts = new Set([...document.scripts].map(s => s.src).filter(Boolean));
  for (const script of next.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const src = new URL(script.getAttribute('src') ?? '', location.href).href;
    if (scripts.has(src)) continue;
    // A parsed script never runs; a created one does.
    const fresh = document.createElement('script');
    fresh.type = 'module';
    fresh.src = src;
    waits.push(loaded(fresh));
    document.head.append(fresh);
  }
  await Promise.all(waits);
}

type Move = (parent: Node, node: Node, before: Node | null) => void;
// moveBefore keeps a node connected (no teardown and setup again).
const move: Move =
  'moveBefore' in Element.prototype
    ? (parent, node, before) =>
        (parent as Element & { moveBefore: (n: Node, b: Node | null) => void }).moveBefore(
          node,
          before,
        )
    : (parent, node, before) => parent.insertBefore(node, before);

/** Replaces the shell's children with the next page's, keeping the
 *  persisted ones (moved to their counterparts' places). */
function swap(page: ShellPage, nextPage: Element): void {
  const kept: { old: Element; slot: Element }[] = [];
  for (const old of page.querySelectorAll(`[${PERSIST}]`)) {
    const key = old.getAttribute(PERSIST) ?? '';
    const twin = nextPage.querySelector(`[${PERSIST}="${CSS.escape(key)}"]`);
    if (!twin) continue;
    // An inert placeholder: the twin would wire itself on connect.
    const slot = nextPage.ownerDocument.createElement('template');
    twin.replaceWith(slot);
    kept.push({ old, slot });
    move(page, old, null);
  }
  const keptSet = new Set(kept.map(k => k.old));
  for (const child of [...page.childNodes]) if (!keptSet.has(child as Element)) child.remove();
  const anchor = page.firstChild;
  for (const child of [...nextPage.childNodes]) page.insertBefore(child, anchor);
  for (const { old, slot } of kept) {
    move(slot.parentNode ?? page, old, slot);
    slot.remove();
  }
}

function announce(title: string): void {
  const region = document.querySelector('[data-page-announcer]');
  if (region) region.textContent = title;
}

function rememberScroll(): void {
  history.replaceState(
    { ...(history.state as object | null), pageRouterScroll: [scrollX, scrollY] },
    '',
  );
}

let current: AbortController | null = null;

async function go(to: URL, traverse: boolean): Promise<void> {
  const page = routed(document);
  if (!page) {
    location.href = to.href;
    return;
  }
  current?.abort();
  const navigation = new AbortController();
  current = navigation;
  const { signal } = navigation;
  if (!traverse) rememberScroll();

  const drawerOpen = page.hasAttribute('nav-open');
  const shut = (): void => {
    if (drawerOpen && !signal.aborted) page.hideNavigation?.();
  };
  const slow = drawerOpen ? setTimeout(shut, DRAWER_WAIT_MS) : undefined;

  const fetched = await pageFor(to, signal);
  if (signal.aborted) return;
  const next = fetched ? parse(fetched.html) : null;
  const nextPage = next ? routed(next) : null;
  if (!fetched || !next || !nextPage) {
    clearTimeout(slow);
    location.href = to.href;
    return;
  }
  next.querySelectorAll('noscript').forEach(n => n.remove());
  await loadAssets(next);
  if (signal.aborted) return;
  clearTimeout(slow);

  document.dispatchEvent(
    new CustomEvent<BeforeSwapDetail>(BEFORE_SWAP, {
      detail: { newDocument: next, to: fetched.url },
    }),
  );
  if (!traverse) history.pushState({}, '', fetched.url);
  else if (fetched.url.href !== location.href) history.replaceState(history.state, '', fetched.url);
  document.title = next.title;
  swap(page, nextPage);
  // astro-lit's hydration-support releases the first page's deferred
  // elements only; these are already defined.
  for (const el of page.querySelectorAll('[defer-hydration]'))
    if (!el.closest('astro-island')) el.removeAttribute('defer-hydration');
  // The drawer shuts over the page it led to.
  shut();
  const saved = (history.state as { pageRouterScroll?: [number, number] } | null)?.pageRouterScroll;
  if (traverse && saved) scrollTo(saved[0], saved[1]);
  else if (fetched.url.hash) document.getElementById(fetched.url.hash.slice(1))?.scrollIntoView();
  else scrollTo(0, 0);
  announce(next.title);
  if (current === navigation) current = null;
}

if (routed(document)) {
  history.scrollRestoration = 'manual';
  // Kept current, so a traversal back or forward lands where it left.
  addEventListener('scrollend', rememberScroll);
  let shown = location.pathname + location.search;

  document.addEventListener('pointerdown', e => {
    const to = routableLink(e);
    if (!to || prefetched?.href === to.href) return;
    prefetched = { href: to.href, at: performance.now(), page: fetchPage(to) };
  });
  document.addEventListener('click', e => {
    const to = routableLink(e);
    if (!to) return;
    e.preventDefault();
    void go(to, false).then(() => (shown = location.pathname + location.search));
  });
  addEventListener('popstate', () => {
    const here = location.pathname + location.search;
    // A fragment step on the same page is the browser's.
    if (here === shown) return;
    void go(new URL(location.href), true).then(() => (shown = location.pathname + location.search));
  });
}
