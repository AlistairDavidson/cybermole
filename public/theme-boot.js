// theme-boot.js — the global light/dark mode's boot half (task/theme-browser).
// A CLASSIC (non-module) script: render-blocking in <head> (Base.astro loads
// it first, before the stylesheets), so the wa-dark/wa-light class is on
// <html> before anything paints — no light-flash for dark users, no
// dark-flash for light ones. External on purpose: the server's CSP is
// `script-src 'self'` (no 'unsafe-inline'), so a literal inline script would
// be refused — this file is same-origin, served pre-auth from public/ exactly
// like sw.js (the login page needs the class before it can have a session).
//
// The class is the app's single mode signal: console.css's two brand token
// sets, color-scheme, the xterm palettes (agent-terminal.ts resolves them
// through getComputedStyle) and the editor pane (terminal-tabs.ts reloads
// it) all key off it. The 'change' listener flips the classes live on a
// browser scheme change.
//
// No-JS fallback: no class means Web Awesome's default light tokens —
// acceptable because the app is JS-dependent anyway; only login works
// without it (rendered light).
(function () {
  var scheme = window.matchMedia("(prefers-color-scheme: dark)");
  var apply = function () {
    var cls = document.documentElement.classList;
    cls.toggle("wa-dark", scheme.matches);
    cls.toggle("wa-light", !scheme.matches);
  };
  apply();
  scheme.addEventListener("change", apply);
})();
