// terminal-ws.spec.ts — task/ws-terminal (docs/plans/workspaces-plan.md §4/§7),
// end to end against the compiled server: the terminal routes wired to
// tmux spawns, the WS 'terminal' attach mode — including the dead-tab
// RESPAWN at the workspace cwd — and the 'run' mode's never-respawn gate,
// plus the split shape's row-created-despite-guard on the create route.
// Non-page spec (split.spec pattern): its own server child(ren) on its own
// port + db + login, so the serial suite's shared login budget and tmux
// socket are untouched; the node:sqlite ExperimentalWarning in the
// set-password boot output is expected (AGENTS.md).
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const PORT = 3485; // clear of the shared :3470 and the specs' own 3471–3484
const BASE = `http://127.0.0.1:${PORT}`;
const USERNAME = 'tester';
const PASSWORD = 'correct-horse-9';
const MARKER = 'TWS_MARKER_READY';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Child env with the CYBERMOLE_ / PI_CODING_AGENT_ overrides stripped: the
 *  values under test must not see this machine's (or the suite
 *  webServer's) explicit settings. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CYBERMOLE_') && !k.startsWith('PI_CODING_AGENT'))
      env[k] = v;
  }
  return { ...env, ...extra };
}

/** Boot one private server. Resolves with its login cookie once it
 *  listens; stop() SIGTERMs it (never the shared webServer) and cleans
 *  up its tmux server + dir. */
async function bootServer(
  dir: string,
  socket: string,
): Promise<{
  cookie: string;
  stop(): Promise<void>;
}> {
  const cmd = path.join(dir, 'cmd.sh');
  fs.writeFileSync(cmd, `#!/bin/sh\necho '${MARKER}'\nexec /bin/sh\n`);
  fs.chmodSync(cmd, 0o755);
  const pw = spawnSync('node', ['dist-server/server/set-password.js'], {
    cwd: ROOT,
    input: `${USERNAME}\n${PASSWORD}\n${PASSWORD}\n`,
    env: bareEnv({ CYBERMOLE_PORT: '0', CYBERMOLE_STATE_DIR: dir }),
  });
  expect(pw.status, pw.stderr?.toString()).toBe(0);

  const child = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: bareEnv({
      CYBERMOLE_PORT: String(PORT),
      CYBERMOLE_HOST: '127.0.0.1',
      CYBERMOLE_STATE_DIR: dir,
      // task/app-web: this spec's server doesn't exercise the apps surface
      // — empty CYBERMOLE_APPS_SOCK keeps the single-user spawn rule from
      // starting a supervised app host beside this boot.
      CYBERMOLE_APPS_SOCK: '',
      CYBERMOLE_TMUX_SOCKET: socket,
      CYBERMOLE_NEW_SESSION_CWD: os.tmpdir(), // deliberately NOT the workspace cwd
      CYBERMOLE_COMMAND: cmd,
      // task/defaults-settings: the auto-opened first tab of every
      // workspace this spec creates — deterministic like CYBERMOLE_COMMAND
      // (the vendored-pi default would drag this checkout's node_modules
      // into the spawn).
      CYBERMOLE_AGENT_COMMAND: cmd,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout!.on('data', (d: Buffer) => {
    boot += d.toString();
  });
  child.stderr!.on('data', (d: Buffer) => {
    boot += d.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not boot; output: ${boot}`)),
      15_000,
    );
    child.stdout!.on('data', () => {
      if (boot.includes('cybermole listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });

  const login = await fetch(`${BASE}/login`, {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).toContain('cybermole_session=');

  const tmuxArgs = (args: string[]) =>
    (socket.startsWith('/') ? ['-S', socket] : ['-L', socket]).concat(args);
  return {
    cookie,
    async stop(): Promise<void> {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      });
      try {
        spawnSync('tmux', tmuxArgs(['kill-server']), { stdio: 'ignore' });
      } catch {
        /* gone */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** tmux CLI against the spec's socket (status: 0 = ok, 1 = refused). */
function tmux(socket: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(
    'tmux',
    (socket.startsWith('/') ? ['-S', socket] : ['-L', socket]).concat(args),
  );
  return { status: r.status, stdout: (r.stdout ?? '').toString() };
}

/** One JSON call against the private server. */
async function api(
  cookie: string,
  method: string,
  url: string,
  body?: unknown,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body, callers narrow it
Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// undici's WebSocket: extra handshake headers ride the options' `headers`
// object (its `origin` option is not the Origin header) — the terminal WS
// is browser-only and demands a same-origin Origin. (The DOM lib's
// WebSocket type doesn't know undici's options form.)
const UndiciWebSocket = WebSocket as unknown as new (
  url: string,
  init: { headers: Record<string, string> },
) => WebSocket;

/** Open the terminal WS, send one attach frame, resolve on the first
 *  'attached' or 'error' answer. The returned socket stays live (output
 *  keeps accumulating into out()) for input round-trips. */
function attachWs(
  cookie: string,
  frame: Record<string, unknown>,
): Promise<{
  ws: WebSocket;
  outcome: { type: 'attached'; target: string } | { type: 'error'; message: string };
  out(): string;
}> {
  const ws = new UndiciWebSocket(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { origin: BASE, cookie },
  });
  const output: string[] = [];
  return new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify(frame));
    ws.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as {
        type: string;
        target?: string;
        message?: string;
        data?: string;
      };
      if (m.type === 'output') {
        output.push(m.data ?? '');
        return;
      }
      if (m.type === 'attached' || m.type === 'error') {
        resolve({
          ws,
          outcome:
            m.type === 'attached'
              ? { type: 'attached', target: m.target ?? '' }
              : { type: 'error', message: m.message ?? '' },
          out: () => output.join(''),
        });
      }
    };
    ws.onclose = () => reject(new Error('ws closed before answering the attach'));
    ws.onerror = () => reject(new Error('ws errored before answering the attach'));
    setTimeout(() => reject(new Error('ws attach timed out')), 10_000).unref?.();
  });
}

const closeWs = (ws: WebSocket | undefined): void => {
  try {
    ws?.close();
  } catch {
    /* closing */
  }
};

test('terminal route spawns; WS terminal mode attaches, round-trips input, RESPAWNS after an out-of-band kill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-tws-'));
  const socket = 'cybermole-itest-tws'; // relative: single-user fork-to-start
  const server = await bootServer(dir, socket);
  try {
    // Create the workspace + a terminal tab through the new routes. No cwd
    // on the create (task/app-cwd — the server derives it), so the distinct
    // dir is set through the PATCH route: this server's configured default
    // is deliberately os.tmpdir(), NOT the workspace cwd the respawns below
    // must land at.
    const wsMade = await api(server.cookie, 'POST', '/api/workspaces', { name: 'scratch' });
    expect(wsMade.status).toBe(200);
    const patched = await api(server.cookie, 'PATCH', `/api/workspaces/${wsMade.json.id}`, {
      cwd: dir,
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    const termMade = await api(
      server.cookie,
      'POST',
      `/api/workspaces/${wsMade.json.id}/terminals`,
      {},
    );
    expect(termMade.status).toBe(200);
    expect(termMade.json.live).toBe(true);
    const termId: string = termMade.json.id;
    expect(termId).toMatch(UUID_RE);

    // The spawn really ran the configured command, on this socket.
    const session = `t-${termId}`;
    await expect
      .poll(() => tmux(socket, ['has-session', '-t', session]).status, { timeout: 5000 })
      .toBe(0);
    await expect
      .poll(() => tmux(socket, ['capture-pane', '-p', '-t', session]).stdout, { timeout: 5000 })
      .toContain(MARKER);

    // WS attach, terminal mode: 'attached' carries the derived tmux name
    // and the pane's content arrives.
    const first = await attachWs(server.cookie, { type: 'attach', mode: 'terminal', id: termId });
    expect(first.outcome).toEqual({ type: 'attached', target: session });
    await expect.poll(first.out, { timeout: 5000 }).toContain(MARKER);

    // Input round-trips through the attached pty.
    const proof = path.join(dir, 'typed.txt');
    first.ws.send(
      JSON.stringify({ type: 'input', data: `echo round-trip > ${JSON.stringify(proof)}\r` }),
    );
    await expect.poll(() => fs.existsSync(proof), { timeout: 5000 }).toBe(true);
    closeWs(first.ws);

    // Out-of-band kill (the workspace-container-loss story): the row is
    // the structure, the next attach RESPAWNS — a fresh command at the
    // WORKSPACE cwd (not CYBERMOLE_NEW_SESSION_CWD, deliberately different).
    expect(tmux(socket, ['kill-session', '-t', session]).status).toBe(0);
    expect(tmux(socket, ['has-session', '-t', session]).status).not.toBe(0);
    const respawned = await attachWs(server.cookie, {
      type: 'attach',
      mode: 'terminal',
      id: termId,
    });
    expect(respawned.outcome).toEqual({ type: 'attached', target: session });
    const pwd = path.join(dir, 'pwd.txt');
    respawned.ws.send(JSON.stringify({ type: 'input', data: `pwd > ${JSON.stringify(pwd)}\r` }));
    await expect
      .poll(() => (fs.existsSync(pwd) ? fs.readFileSync(pwd, 'utf8').trim() : ''), {
        timeout: 5000,
      })
      .toBe(dir);
    closeWs(respawned.ws);

    // 'run' mode NEVER respawns: a session that died answers an error,
    // not a fresh one (job runs are the session — a re-run is a new one).
    expect(tmux(socket, ['new-session', '-d', '-s', 'cybermole-probe', '-c', dir]).status).toBe(0);
    const run = await attachWs(server.cookie, {
      type: 'attach',
      mode: 'run',
      target: 'cybermole-probe',
    });
    expect(run.outcome).toEqual({ type: 'attached', target: 'cybermole-probe' });
    closeWs(run.ws);
    expect(tmux(socket, ['kill-session', '-t', 'cybermole-probe']).status).toBe(0);
    const runDead = await attachWs(server.cookie, {
      type: 'attach',
      mode: 'run',
      target: 'cybermole-probe',
    });
    expect(runDead.outcome).toEqual({ type: 'error', message: 'no such run session' });
    closeWs(runDead.ws);
    // and no session got respawned under that name
    expect(tmux(socket, ['has-session', '-t', 'cybermole-probe']).status).not.toBe(0);

    // Close the tab: row + session both gone.
    const closed = await api(server.cookie, 'DELETE', `/api/terminals/${termId}`);
    expect(closed.status).toBe(200);
    await expect
      .poll(() => tmux(socket, ['has-session', '-t', session]).status, { timeout: 5000 })
      .not.toBe(0);
  } finally {
    await server.stop();
  }
});

test('split shape (absolute socket, no server): the create still returns its row (503) and the attach surfaces the guard, then respawns once the server is up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-tws-split-'));
  const socket = path.join(dir, 'tmux'); // absolute ⇒ split mode: -S + never-fork guard
  const server = await bootServer(dir, socket);
  try {
    // No cwd on the create (task/app-cwd): the dir rides the PATCH route.
    const wsMade = await api(server.cookie, 'POST', '/api/workspaces', { name: 'split' });
    expect(wsMade.status).toBe(200);
    const patched = await api(server.cookie, 'PATCH', `/api/workspaces/${wsMade.json.id}`, {
      cwd: dir,
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);

    // Workspace server down: the spawn's never-fork guard refuses — 503
    // with the row attached (plan §4: a dead tab, not a missing one) —
    // and no tmux server gets forked as the web uid.
    const refused = await api(
      server.cookie,
      'POST',
      `/api/workspaces/${wsMade.json.id}/terminals`,
      {},
    );
    expect(refused.status).toBe(503);
    expect(refused.json.code).toBe('server_not_running');
    expect(refused.json.error).toContain('workspace tmux server not running');
    expect(refused.json.terminal.id).toMatch(UUID_RE);
    expect(refused.json.terminal.live).toBe(false);
    expect(fs.existsSync(socket)).toBe(false);

    // Same refusal on the WS terminal attach path (the respawn's guard):
    // the message, not a generic failure — and still no fork.
    const termId: string = refused.json.terminal.id;
    const down = await attachWs(server.cookie, { type: 'attach', mode: 'terminal', id: termId });
    expect(down.outcome).toEqual({ type: 'error', message: 'workspace tmux server not running' });
    closeWs(down.ws);
    expect(fs.existsSync(socket)).toBe(false);

    // Bring the workspace side up exactly like the entrypoint (split.spec
    // pattern): umask 0007, exit-empty off on the server conf, chmod 0660.
    const conf = path.join(dir, 'conf-src');
    fs.writeFileSync(conf, 'set -g exit-empty off\n');
    spawnSync('sh', [
      '-c',
      `umask 0007; tmux -S ${socket} -f ${conf} start-server && chmod 0660 ${socket}`,
    ]);
    expect(fs.statSync(socket).mode & 0o777).toBe(0o660);

    // The SAME terminal tab now attaches — the deferred respawn ran the
    // configured command at the workspace cwd on the shared socket.
    const attached = await attachWs(server.cookie, {
      type: 'attach',
      mode: 'terminal',
      id: termId,
    });
    expect(attached.outcome).toEqual({ type: 'attached', target: `t-${termId}` });
    await expect.poll(attached.out, { timeout: 5000 }).toContain(MARKER);
    closeWs(attached.ws);
  } finally {
    await server.stop();
  }
});
