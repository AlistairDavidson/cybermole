// The ping action's enhancer (CODE_STYLE.md §7): <notes-ping> wraps the
// SSR'd controls and the aria-live line, and this wires the button to the
// store's pingGo and mirrors pingStatus into the line. Enhance, never
// render — the children are the content.
import { effect } from '@preact/signals-core';
import { defineElement, waValue } from '@cybermole/app-kit/element';
import { pingGo, pingStatus } from '../store/ping';

defineElement('notes-ping', host => {
  const input = host.querySelector('wa-input');
  const button = host.querySelector('wa-button');
  const out = host.querySelector('p[aria-live]');
  button?.addEventListener('click', () => {
    void pingGo(waValue(input));
  });
  return effect(() => {
    if (out !== null) out.textContent = pingStatus.value;
  });
});
