// storage.ts — the console's object-storage wiring. The client itself is
// the kit's now (packages/app-kit/src/storage.ts — task/app-kit,
// docs/plans/apps-plan.md §5); this module injects the console's component
// logger so the storage lines keep their [storage] prefix through winston
// (console + loki, src/lib/logger.ts) exactly as before the move, and
// re-exports the surface the console imports (server/main.ts builds the
// ObjectStore; services/env/parsing/responses carry its types).
//
// Importing this module IS the wiring: module scope runs it once, before
// any ObjectStore is constructed.
import { componentLogger } from './logger';
import { setStorageLogger } from '@cybermole/app-kit';

setStorageLogger(componentLogger('storage'));

export { ObjectStore } from '@cybermole/app-kit';
export type {
  FetchObjectErrorCode,
  FetchObjectFailure,
  FetchObjectFailureData,
  FetchObjectResult,
  FetchObjectSuccess,
  FetchedObject,
  ObjectInfo,
  ObjectRange,
  ObjectStoreConfig,
  StatObjectErrorCode,
  StatObjectFailure,
  StatObjectResult,
  StatObjectSuccess,
  StoreUploadData,
  StoreUploadErrorCode,
  StoreUploadFailure,
  StoreUploadResult,
  StoreUploadSuccess,
  UploadInput,
} from '@cybermole/app-kit';
