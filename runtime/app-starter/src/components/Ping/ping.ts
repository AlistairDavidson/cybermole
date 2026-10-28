// The ping action's enhancer (CODE_STYLE.md §7): wires the SSR'd controls
// (Ping.astro, this directory) to the store (src/store/ping.ts). The
// directory owns its wa-* halves: wa-client first, then the client-side
// re-imports of what the .astro SSRs.
import '@cybermole/app-kit/wa-client';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { effect } from '@preact/signals-core';
import { defineElement, waValue } from '@cybermole/app-kit/element';
import { pingGo, pingStatus } from '../../store/ping';

defineElement('__APP_SLUG__-ping', host => {
  const input = host.querySelector('wa-input');
  const button = host.querySelector('wa-button');
  const out = host.querySelector('p[aria-live]');
  const onClick = (): void => {
    void pingGo(waValue(input));
  };
  button?.addEventListener('click', onClick);
  const dispose = effect(() => {
    if (out !== null) out.textContent = pingStatus.value;
  });
  // Full teardown: listeners off too, or a re-parented host double-wires.
  return () => {
    button?.removeEventListener('click', onClick);
    dispose();
  };
});
