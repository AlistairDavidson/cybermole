// The app's WS entry (copied verbatim into dist/server/ws.mjs by the
// build's writeWsEntry hook — see the app-starter README § WebSocket
// routes). One example use: the change signal behind the live list. A
// watcher on the db broadcasts notes_changed to every open socket; clients
// answer by re-fetching over the normal HTTP actions — WS carries the
// nudge, HTTP carries the data. Self-contained on purpose: node: builtins
// and ws only, no src/lib imports (this sits outside entry.mjs's
// self-containment graph).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const clients = new Set();

// dist/server/ws.mjs → the app root two levels up.
const dataDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data',
);

export function handleUpgrade(req, socket, head) {
  const p = (req.url ?? '').split('?')[0];
  if (p !== '/apps/notes/ws') {
    // The app is the router: unknown paths refuse, never hang.
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    // One-way by design: clients that talk back get shown the door.
    ws.on('message', () => ws.close(1008, 'server-to-client only'));
  });
}

// sqlite commits touch app.db and its -journal side files; watching the
// directory catches create and modify alike, and the debounce coalesces a
// commit's burst into one signal.
let timer = null;
const changed = () => {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    const note = JSON.stringify({ type: 'notes_changed' });
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(note);
  }, 150);
};
fs.watch(dataDir, { persistent: false }, (_event, file) => {
  if (typeof file === 'string' && file.startsWith('app.db')) changed();
});
