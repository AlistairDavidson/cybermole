// index.ts — @cybermole/app-kit's public surface (the package's "."
// export). One entry on purpose: server-compiled code (tsconfig.server.json
// → dist-server) imports the kit ONLY through this specifier — the manifest
// tools/place-kit-manifest.mjs writes into dist-server maps exactly ".".
// Client/vite code may use the subpaths (./wa-client, ./island,
// ./route-table) but the root serves it all.
//
// Filled in by the move commits (task/app-kit, docs/apps-plan.md §5):
// types, schemas, web responses, db, storage, route-table, island.
