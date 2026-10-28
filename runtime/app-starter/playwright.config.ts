// The app-side e2e loop on the kit's harness (see README § End-to-end
// tests): `npm run test:e2e` — deliberately outside `npm run check`. The
// factory carries the shared shape (serial, list reporter, chromium, the
// kit's global setup); specs locate the tree themselves.
import { appPlaywrightConfig } from '@cybermole/app-kit/testing';

export default appPlaywrightConfig();
