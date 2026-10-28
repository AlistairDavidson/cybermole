// Live client state for the ping action (the worked example of the store
// convention: signals + the typed route client — the same route table the
// API serves).
import { signal } from '@preact/signals-core';
import { createRouteClient } from '@cybermole/app-kit/route-table';
import { routes } from '../routes';

const client = createRouteClient(routes, { base: import.meta.env.BASE_URL });

export const pingStatus = signal('— not pinged yet —');

export async function pingGo(name: string): Promise<void> {
  pingStatus.value = '…';
  const r = await client.ping({ params: {}, query: { name } });
  pingStatus.value = r.ok
    ? `pong — hello, ${r.data.hello}`
    : `error: ${r.errorMessage ?? r.errorCode}`;
}
