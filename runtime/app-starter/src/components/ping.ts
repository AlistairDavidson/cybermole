// The ping action's UI: an HTML web component enhancing the SSR'd
// controls (the worked example of the enhancer convention — CODE_STYLE.md §7).
import { effect } from '@preact/signals-core';
import { defineElement, waValue } from '@cybermole/app-kit/element';
import { pingGo, pingStatus } from '../store/ping';

defineElement('__APP_SLUG__-ping', host => {
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
