// The example action's UI: a preact island with signals, calling the action
// through the kit's typed client over the same route table the API serves.
import { useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { createRouteClient } from '@cybermole/app-kit/route-table';
import { routes } from '../routes';

/** .value is absent until the element upgrades. */
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
