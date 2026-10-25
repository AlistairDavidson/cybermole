// The object store client lives in the kit; importing this module wires in
// the console's [storage] logger before any ObjectStore is built.
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
