// state-dir.spec.ts — default state layout (DESIGN_REVIEW §3.3): with only
// CYBERMOLE_HOME (and a port) set, everything cybermole persists lands under
// $CYBERMOLE_HOME/.local/state/cybermole — set-password writes cybermole.db there,
// the server seeds pi-agent/ from the repo runtime/pi-agent-dir/ template — while
// CYBERMOLE_STATE_DIR and the per-path overrides still win. Runs the compiled
// dist-server via child_process (like global-setup), not imports, so it
// covers the built artifact an operator actually runs.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const INPUT = 'tester\ncorrect-horse-9\ncorrect-horse-9\n';
/** compose's dev seed input: user/pass/pass piped to --if-unset (the dev
 *  service's printf — test/test, under the ≥8 minimum the interactive and
 *  plain piped modes keep). */
const SEED_INPUT = 'test\ntest\ntest\n';

/** Child env with the CYBERMOLE_ / PI_CODING_AGENT_ overrides stripped: the
 *  defaults under test must not see this machine's (or the suite's
 *  webServer's) explicit values. */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CYBERMOLE_') && !k.startsWith('PI_CODING_AGENT'))
      env[k] = v;
  }
  return { ...env, ...extra };
}

/** run set-password with exactly the given CYBERMOLE_* vars (port 0: never a
 *  real listener; set-password only parses the env, it never binds). */
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

/** Boot the compiled server with exactly the given CYBERMOLE_* vars and
 *  wait for its listening log (seedAgentDir() runs synchronously before
 *  listen — by the time the boot log prints, the runtime dir exists and is
 *  seeded), then stop it and AWAIT the exit: the graceful-shutdown handler
 *  (session-lifecycle) drains sockets before exiting, so a fire-and-forget
 *  kill could wedge the suite's worker teardown. Port 0 + the spec's own
 *  tmux socket: never collides with the suite's :3470. */
async function bootServer(env: Record<string, string>): Promise<void> {
  const child = spawn('node', ['dist-server/server/main.js'], {
    cwd: ROOT,
    env: bareEnv({
      CYBERMOLE_PORT: '0',
      CYBERMOLE_HOST: '127.0.0.1',
      CYBERMOLE_TMUX_SOCKET: 'cybermole-state-itest',
      // task/app-web: no apps surface here — keeps the single-user spawn
      // rule from starting a supervised app host beside each boot.
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

/** Assert dir was seeded byte-identical from the repo's runtime/pi-agent-dir/ template. */
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
  // The dev profile's boot command, through the built artifact: the seed
  // lands in CYBERMOLE_STATE_DIR (under the ≥8 minimum — the mode's
  // deliberate exception), and a later human password survives the seed
  // re-running on every recreate.
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
