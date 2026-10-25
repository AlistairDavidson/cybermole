// Inline import() types: a top-level import would make this a module and
// stop it augmenting the global App namespace.
declare namespace App {
  interface Locals {
    cybermole?: import('./lib/platform/services').CybermoleServices;
    session?: import('@cybermole/app-kit').SessionToken;
  }
}
