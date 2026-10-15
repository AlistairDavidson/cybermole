// restart.spec.ts — login sessions persist (auth_sessions in the state db,
// src/lib/auth.ts): a cookie issued by one server process is still valid
// after that process stops and a fresh one boots on the same state db,
// and a password change (setCredential) revokes it. Non-page spec
// (state-dir / split pattern): spawns its OWN server children on its own
// port, so the login below spends that private process's rate-limit
// budget, not the shared :3470 webServer's.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { setCredential } from '../src/lib/auth';
import { StateDb } from '../src/lib/db';
import { PASSWORD, USERNAME } from './env';

const ROOT = path.resolve(__dirname, '..');
const PORT = 3483;
const BASE = `http://127.0.0.1:${PORT}`;

/** Child env with the WEB_PI_ / PI_CODING_AGENT_ overrides stripped. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('WEB_PI_') && !k.startsWith('PI_CODING_AGENT')) env[k] = v;
  }
  return { ...env, ...extra };
}

async function boot(dir: string): Promise<ChildProcess> {
  const child = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: bareEnv({
      WEB_PI_PORT: String(PORT),
      WEB_PI_HOST: '127.0.0.1',
      WEB_PI_STATE_DIR: dir,
      WEB_PI_TMUX_SOCKET: `webpi-restart-itest-${process.pid}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not boot; stdout: ${out}`)),
      15_000,
    );
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('web-pi listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref(); // wedged-child backstop
  });
}

test('a login survives a server restart; a password change revokes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpi-restart-'));
  const dbFile = path.join(dir, 'webpi.db');
  expect(setCredential(new StateDb(dbFile), USERNAME, PASSWORD).ok).toBe(true);

  let child = await boot(dir);
  try {
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(/^webpi_session=[0-9a-f]{64}$/);
    const state = () => fetch(`${BASE}/api/state`, { headers: { cookie } });
    expect((await state()).status).toBe(200);

    // The token itself never reaches the db — only its hash.
    expect(fs.readFileSync(dbFile).includes(Buffer.from(cookie.split('=')[1]!))).toBe(false);

    // Restart: a fresh process on the same state db still knows the cookie.
    await stop(child);
    child = await boot(dir);
    expect((await state()).status).toBe(200);

    // A password change (what `npm run set-password` does) signs it out.
    expect(setCredential(new StateDb(dbFile), USERNAME, 'another-horse-9').ok).toBe(true);
    expect((await state()).status).toBe(401);
  } finally {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
