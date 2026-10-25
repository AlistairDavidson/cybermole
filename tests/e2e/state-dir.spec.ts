// With only CYBERMOLE_HOME set, everything persists under
// $CYBERMOLE_HOME/.local/state/cybermole (the db, the seeded pi-agent/),
// while CYBERMOLE_STATE_DIR and per-path overrides still win. Runs the
// compiled dist-server, the artifact an operator runs.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..', '..');
const INPUT = 'tester\ncorrect-horse-9\ncorrect-horse-9\n';
/** The dev seed's input (test/test is under the 8-char minimum on purpose). */
const SEED_INPUT = 'test\ntest\ntest\n';

/** The machine's and suite's CYBERMOLE_ / PI_CODING_AGENT_ settings must not leak in. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CYBERMOLE_') && !k.startsWith('PI_CODING_AGENT'))
      env[k] = v;
  }
  return { ...env, ...extra };
}

/** Port 0: set-password only parses the env, never binds. */
function setPassword(env: Record<string, string>, args: string[] = [], input = INPUT) {
  return spawnSync('node', ['dist-server/server/set-password.js', ...args], {
    cwd: ROOT,
    env: bareEnv({ CYBERMOLE_PORT: '0', ...env }),
    input,
  });
}

test('set-password with only CYBERMOLE_HOME defaults the db into ~/.local/state/cybermole', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-state-home-'));
  const r = setPassword({ CYBERMOLE_HOME: home });
  expect(r.status, r.stderr?.toString()).toBe(0);
  const db = path.join(home, '.local', 'state', 'cybermole', 'cybermole.db');
  expect(fs.existsSync(db)).toBe(true);
  expect(fs.statSync(db).mode & 0o777).toBe(0o600); // it holds the password hash
  const row = new DatabaseSync(db).prepare('SELECT username FROM credential').get() as
    { username: string } | undefined;
  expect(row?.username).toBe('tester');
});

/** Waits for the listening log (seeding runs before listen), then stops
 *  it and awaits the exit: the graceful drain could otherwise wedge the
 *  worker's teardown. */
async function bootServer(env: Record<string, string>): Promise<void> {
  const child = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: bareEnv({
      CYBERMOLE_PORT: '0',
      CYBERMOLE_HOST: '127.0.0.1',
      CYBERMOLE_TMUX_SOCKET: 'cybermole-state-itest',
      // no apps surface here
      CYBERMOLE_APPS_SOCK: '',
      ...env,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d: Buffer) => {
    out += d.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server did not boot; stdout: ${out}`)),
        15_000,
      );
      child.stdout!.on('data', () => {
        if (out.includes('cybermole listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref(); // wedged-child backstop
    });
  }
}

/** Byte-identical to runtime/pi-agent-dir/. */
function expectSeededFromTemplate(dir: string): void {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  const templateFiles = walk(path.join(ROOT, 'runtime', 'pi-agent-dir'));
  expect(templateFiles.length).toBeGreaterThan(0);
  for (const src of templateFiles) {
    const dst = path.join(dir, path.relative(path.join(ROOT, 'runtime', 'pi-agent-dir'), src));
    expect(fs.existsSync(dst), dst).toBe(true);
    expect(fs.readFileSync(dst, 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
  }
}

test('server boot seeds pi-agent from the repo template; CYBERMOLE_AGENT_DIR outranks CYBERMOLE_STATE_DIR', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-state-home-'));
  await bootServer({ CYBERMOLE_HOME: home });
  expectSeededFromTemplate(path.join(home, '.local', 'state', 'cybermole', 'pi-agent'));

  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-state-dir-'));
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-agent-dir-'));
  await bootServer({
    CYBERMOLE_HOME: home,
    CYBERMOLE_STATE_DIR: state,
    CYBERMOLE_AGENT_DIR: agent,
  });
  expectSeededFromTemplate(agent); // the per-path override wins, not <state>/pi-agent
  expect(fs.existsSync(path.join(state, 'pi-agent'))).toBe(false);
});

test('CYBERMOLE_STATE_DIR moves the layout; CYBERMOLE_DB_FILE still outranks it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-state-home-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-state-dir-'));
  const explicit = path.join(home, 'explicit.db');

  const a = setPassword({ CYBERMOLE_HOME: home, CYBERMOLE_STATE_DIR: state });
  expect(a.status, a.stderr?.toString()).toBe(0);
  expect(fs.existsSync(path.join(state, 'cybermole.db'))).toBe(true);
  expect(fs.existsSync(path.join(home, '.local'))).toBe(false);

  const before = fs.statSync(path.join(state, 'cybermole.db')).mtimeMs;
  const b = setPassword({
    CYBERMOLE_HOME: home,
    CYBERMOLE_STATE_DIR: state,
    CYBERMOLE_DB_FILE: explicit,
  });
  expect(b.status, b.stderr?.toString()).toBe(0);
  expect(fs.existsSync(explicit)).toBe(true);
  expect(fs.statSync(path.join(state, 'cybermole.db')).mtimeMs).toBe(before); // untouched
});

test('--if-unset seeds a fresh state dir once, never over an existing credential', () => {
  // The dev profile's seed: lands in CYBERMOLE_STATE_DIR despite the short
  // password, and a later human password survives the seed re-running.
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cybermole-state-dir-'));
  const db = path.join(state, 'cybermole.db');
  const username = () =>
    (
      new DatabaseSync(db).prepare('SELECT username FROM credential').get() as
        { username: string } | undefined
    )?.username;

  const seed = setPassword({ CYBERMOLE_STATE_DIR: state }, ['--if-unset'], SEED_INPUT);
  expect(seed.status, seed.stderr?.toString()).toBe(0);
  expect(username()).toBe('test');

  const changed = setPassword({ CYBERMOLE_STATE_DIR: state }); // dev:set-password
  expect(changed.status, changed.stderr?.toString()).toBe(0);
  expect(username()).toBe('tester');

  const reseed = setPassword({ CYBERMOLE_STATE_DIR: state }, ['--if-unset'], SEED_INPUT);
  expect(reseed.status, reseed.stderr?.toString()).toBe(0);
  expect(reseed.stdout?.toString()).toBe(''); // silent no-op
  expect(username()).toBe('tester'); // the user's password survived the recreate
});
