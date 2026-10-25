// PingIsland.tsx — the example action's UI: a preact island with signals
// (the kit's convention — pages render server-side, islands carry the
// interactive regions, client state lives in signals so prop drilling
// and effect chains stay out of small UIs). The action call goes through
// the kit's typed client on the SAME table the API route serves — one
// action vocabulary, every face (apps-plan §0).
import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { createRouteClient } from '@cybermole/app-kit/route-table';
import { routes } from '../routes';

/** The wa-input host after the browser upgrades it (before that, .value
 *  is absent — the island reads it defensively). */
interface WaInputHost extends HTMLElement {
  value: string | null;
}

const client = createRouteClient(routes, { base: import.meta.env.BASE_URL });
const result = signal('— not pinged yet —');

export default function PingIsland() {
  const input = useRef<WaInputHost | null>(null);
  const go = async () => {
    const name = (input.current?.value ?? '').trim();
    result.value = '…';
    const r = await client.ping({ params: {}, query: { name } });
    result.value = r.ok
      ? `pong — hello, ${r.data.hello}`
      : `error: ${r.errorMessage ?? r.errorCode}`;
  };
  return (
    <>
      <wa-input label="name" value="world" ref={input}></wa-input>{' '}
      <wa-button variant="brand" onClick={go}>
        ping
      </wa-button>
      <p aria-live="polite">{result.value}</p>
    </>
  );
}
