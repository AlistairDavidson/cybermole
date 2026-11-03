// Sets wa-dark/wa-light on <html> from prefers-color-scheme before first
// paint, and flips it live. A classic render-blocking script, external
// because the CSP has no 'unsafe-inline'; served pre-auth for the login page.
// The class is the app's single mode signal (tokens, xterm, the editor pane).
(function () {
  var scheme = window.matchMedia('(prefers-color-scheme: dark)');
  var apply = function () {
    var cls = document.documentElement.classList;
    cls.toggle('wa-dark', scheme.matches);
    cls.toggle('wa-light', !scheme.matches);
  };
  apply();
  scheme.addEventListener('change', apply);
  // A ClientRouter swap replaces <html>'s attributes with the next page's
  // SSR'd ones (no mode class): carry the class over before it lands.
  document.addEventListener('astro:before-swap', function (e) {
    var cls = e.newDocument.documentElement.classList;
    cls.toggle('wa-dark', scheme.matches);
    cls.toggle('wa-light', !scheme.matches);
  });
})();
