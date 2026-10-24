// index.ts — @cybermole/app-kit's public surface (the package's "."
// export). One entry on purpose: server-compiled code (tsconfig.server.json
// → dist-server) imports the kit ONLY through this specifier — the manifest
// tools/place-kit-manifest.mjs writes into dist-server maps exactly ".".
// Client/vite code may use the subpaths (./wa-client, ./island,
// ./route-table) but the root serves it all.
//
// Everything here is side-effect-free module scope (classes and function
// declarations), which is why the package can claim sideEffects: false
// (wa-client.ts, the one side-effecting module, is carved out in
// package.json): bundlers drop whatever an importer doesn't use, so client
// code pulling a schema never also pulls node:sqlite or the S3 SDK.
export * from './types/result';
export * from './types/branded';
export * from './schemas/patterns';
export * from './schemas/ids';
