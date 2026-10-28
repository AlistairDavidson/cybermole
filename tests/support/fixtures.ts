// The fixture world's live tmux sessions: written by global-setup right
// after it spawns them, healed by e2e.spec's beforeAll. The fixture
// terminals are created once, minutes before the specs that assert their
// liveness run, and a session that dies out-of-band in between is never
// retried by design (only an attach respawns) — scratch heals itself
// through the apps specs' own page attaches, but deploy's tab is attached
// by nothing, so its badge would be gone forever. The heal re-establishes
// the precondition where the tests need it instead of waiting on a
// liveness that can no longer return.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TMUX_SOCKET, WORKSPACE } from './env';

/** Under WORKSPACE, so the per-run reset clears it with the rest. */
export const FIXTURE_SESSIONS_FILE = path.join(WORKSPACE, '.fixture-terminals.json');

/** One live-fixture session global-setup spawned (or the heal must). */
export interface FixtureSession {
  session: string;
  cwd: string;
}

export function writeFixtureSessions(entries: FixtureSession[]): void {
  fs.writeFileSync(FIXTURE_SESSIONS_FILE, JSON.stringify(entries));
}

function tmuxStatus(args: string[]): number {
  return spawnSync('tmux', ['-L', TMUX_SOCKET, ...args], { stdio: 'ignore' }).status ?? 1;
}

/** The live session names on the suite socket; an empty set when no
 *  server answers (the respawn then boots one). */
function liveSessionNames(): Set<string> {
  const res = spawnSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return new Set();
  return new Set(res.stdout.split('\n').filter(Boolean));
}

/** Same command shape as global-setup's fixture spawn. `-f` only matters
 *  when the server boots, so it rides just the first respawn: if the tmux
 *  server died mid-suite, the heal's first new-session must boot it with
 *  the app's conf (the backfill tests depend on its terminal-overrides). */
function respawn(session: string, cwd: string, withConf: boolean, cmd: string): void {
  const conf = withConf ? ['-f', path.resolve(__dirname, '..', '..', 'runtime', 'tmux.conf')] : [];
  tmuxStatus([...conf, 'new-session', '-d', '-s', session, '-c', cwd, '--', cmd]);
}

/** Verifies every live-fixture session still exists and re-spawns (once)
 *  any that died out-of-band since global-setup. Returns the healed
 *  session names — empty when the fixture world is intact. Throws on a
 *  respawn that fails, so a broken fixture fails this file fast with a
 *  diagnostic instead of a liveness wait that can never succeed. */
export function ensureFixtureSessions(): string[] {
  const cmd = path.join(WORKSPACE, 'cmd.sh');
  const entries: FixtureSession[] = JSON.parse(fs.readFileSync(FIXTURE_SESSIONS_FILE, 'utf8'));
  const live = liveSessionNames();
  const healed: string[] = [];
  let first = true;
  for (const { session, cwd } of entries) {
    if (live.has(session)) continue;
    respawn(session, cwd, first, cmd);
    first = false;
    // A duplicate-session error means a concurrent attach-respawn won the
    // race; anything else that left the session dead is fatal.
    if (tmuxStatus(['has-session', '-t', session]) !== 0) {
      throw new Error(`e2e fixtures: respawn of ${session} at ${cwd} failed`);
    }
    healed.push(session);
  }
  return healed;
}
