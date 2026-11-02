// AppShell's client half (side effects): the wa-* client prelude, the
// shell's own wa-* halves, the console's icon libraries and the nav's
// enhancers. An app page's client script imports it first, in place of
// wa-client.
import '../../wa-client';
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/toast/toast.js';
import { registerCybermoleIcons } from '../../icons';
import '../AppNav/app-nav';

// The side nav carries the console's base (module scripts run after parse).
registerCybermoleIcons(document.querySelector<HTMLElement>('side-nav')?.dataset.base ?? '');
