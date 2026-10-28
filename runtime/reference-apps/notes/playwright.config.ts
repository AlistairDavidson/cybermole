// The app-side e2e loop on the kit's harness (see this tree's README §
// End-to-end tests): `npm run test:e2e` — deliberately outside `npm run
// check`. The factory carries the shared shape; the specs locate the tree.
import { appPlaywrightConfig } from '@cybermole/app-kit/testing';

export default appPlaywrightConfig();
