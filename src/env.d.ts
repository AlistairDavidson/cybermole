// Astro.locals for the cybermole server (src/lib/services.ts CybermoleLocals):
// server/main.ts passes these to the Astro handler on the authenticated
// path only; src/middleware.ts fails closed without them. Inline import()
// types — a top-level import would turn this file into a module and stop
// it augmenting the global App namespace.
declare namespace App {
  interface Locals {
    cybermole?: import('./lib/services').CybermoleServices;
    session?: import('./types/branded').SessionToken;
  }
}
