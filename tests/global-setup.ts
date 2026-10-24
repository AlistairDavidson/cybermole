// global-setup.ts — hermetic workspace for the e2e run.
// The webServer (playwright.config.ts) boots before this runs; that's fine:
// the server opens the state db and tmux socket lazily.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setCredential } from '../src/lib/auth';
import { StateDb, qb, type DatabaseReadResult } from '../src/lib/db';
import { Apps } from '../src/lib/apps';
import { Workspaces } from '../src/lib/workspaces';
import { terminalSessionName } from '../src/lib/tmux';
import { asAppId, asTerminalId } from '@cybermole/app-kit';
import { AGENT_MARKER, MARKER, PASSWORD, TMUX_SOCKET, USERNAME, WORKSPACE } from './env';

export default async function globalSetup(): Promise<void> {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  // Login credential in the state db (Auth reads the row per attempt;
  // the server opens the db lazily — only after this reset).
  const db = new StateDb(path.join(WORKSPACE, 'cybermole.db'));
  const saved = setCredential(db, USERNAME, PASSWORD);
  if (!saved.ok) throw new Error(`global-setup: ${saved.errorMessage}`);

  // Deterministic command for new terminal tabs: banner + a shell we can
  // type into. CYBERMOLE_COMMAND is whitespace-split, so it must be one
  // path. `agent` is the marker argument the AUTO-OPENED first terminal of
  // a new workspace runs under (CYBERMOLE_AGENT_COMMAND — a distinct
  // banner so the agent tab is tellable from a plain one).
  const cmd = path.join(WORKSPACE, 'cmd.sh');
  fs.writeFileSync(
    cmd,
    `#!/bin/sh\nif [ "$1" = "agent" ]; then echo '${AGENT_MARKER}'; else echo '${MARKER}'; fi\nexec /bin/sh\n`,
  );
  fs.chmodSync(cmd, 0o755);

  // Fixture workspace tree (plan §5), written through the real domains:
  // one app, two console workspaces, one app workspace, terminals under
  // them. Rows only — no eager spawns; which fixture tabs read as LIVE is
  // decided by the tmux sessions below (the live diff is tmux-derived).
  // The create AUTO-OPENS each workspace's first terminal (task/
  // defaults-settings — the agent slot), so `titles` names only the
  // EXTRA tabs beyond it: scratch gets one extra (its dead-tab fixture),
  // deploy and proj none.
  const username = (): DatabaseReadResult<string | null> => ({
    ok: true,
    resultType: 'database_read',
    data: { value: USERNAME },
  });
  const apps = new Apps({ db, username, killSession: async () => true });
  const cmdOk = (command: string): DatabaseReadResult<string> => ({
    ok: true,
    resultType: 'database_read',
    data: { value: command },
  });
  const workspaces = new Workspaces({
    db,
    username,
    killSession: async () => true,
    defaultCwd: WORKSPACE,
    spawnSession: async name => ({ ok: true, resultType: 'tmux_session', data: { name } }),
    liveSessionNames: async () => new Set(),
    shellCommand: () => cmdOk(cmd),
    agentCommand: () => cmdOk(`${cmd} agent`),
  });
  const dir = (name: string): string => {
    const d = path.join(WORKSPACE, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const app = await apps.saveApp('alpha app');
  if (!app.ok) throw new Error(`global-setup: ${app.errorMessage}`);
  const seeded = async (
    name: string,
    cwd: string,
    appId: string | null,
    titles: string[],
  ): Promise<{ cwd: string; terminals: string[] }> => {
    const ws = await workspaces.saveWorkspace(
      appId === null ? { name, cwd } : { appId: asAppId(appId), name, cwd },
    );
    if (!ws.ok) throw new Error(`global-setup: ${ws.errorMessage}`);
    // The create auto-opened the first tab (the agent slot — task/
    // defaults-settings); read its row back so the fixture's terminal
    // list starts with it, in tab order.
    const autoRow = db.get(
      qb
        .selectFrom('terminals')
        .select('id')
        .where('workspace_id', '=', ws.data.id)
        .orderBy('sort_order', 'asc'),
    );
    if (!autoRow) throw new Error('global-setup: auto-opened terminal missing');
    const terminals: string[] = [autoRow.id];
    for (const title of titles) {
      const t = await workspaces.newTerminal(ws.data.id, title === '' ? undefined : title);
      if (!t.ok) throw new Error(`global-setup: ${t.errorMessage}`);
      terminals.push(t.data.id);
    }
    return { cwd, terminals };
  };
  const scratch = await seeded('scratch', dir('scratch'), null, ['build']);
  const deploy = await seeded('deploy checklist', dir('deploy'), null, []);
  const proj = await seeded('proj', dir('proj'), app.data.id, []);

  // Kill any leftover test tmux server from a previous aborted run —
  // BEFORE the live fixtures below, which must survive into the suite —
  // and WAIT for it to be gone: between kill-server's reply and the
  // server process actually exiting, a client that connects gets
  // "server exited unexpectedly" (observed whenever the previous run
  // left a loaded server behind). list-sessions is the probe — a server
  // still answering means alive, "server exited unexpectedly" means
  // dying, and anything else ("no server running", no socket file) is
  // gone. It never forks a server of its own.
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* no server running — fine */
  }
  const serverGone = (): boolean => {
    try {
      execFileSync('tmux', ['-L', TMUX_SOCKET, 'list-sessions'], { stdio: 'ignore' });
      return false; // a server is still answering
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? '';
      return !stderr.includes('server exited unexpectedly');
    }
  };
  const deadline = Date.now() + 10_000;
  while (!serverGone()) {
    if (Date.now() > deadline) throw new Error('global-setup: leftover tmux server refused to die');
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Live fixture tabs: real tmux sessions named t-<uuid> at their
  // workspace cwd (the derived-name contract, plan §4) running cmd.sh.
  // scratch's second tab ('build') stays DEAD (no session) — the dead-tab
  // story (live:false, attach respawns) is part of what the suite asserts.
  // The first tab is the live one on purpose: it is the tab auto-selected
  // at login, and a live auto-selection attaches without respawning.
  // -f on the FIRST session starts the server under the app's own conf
  // (exactly what the app's first new-session does — terminal-search made
  // that conf load-bearing: its terminal-overrides keep attached clients
  // in the normal buffer so scrollback survives, which the backfill tests
  // rely on and production always runs with).
  let first = true;
  for (const [group, index] of [
    [scratch, 0],
    [deploy, 0],
    [proj, 0],
  ] as const) {
    const id = group.terminals[index];
    if (!id) throw new Error('global-setup: fixture terminal missing');
    execFileSync('tmux', [
      '-L',
      TMUX_SOCKET,
      ...(first ? ['-f', path.resolve(__dirname, '..', 'tmux.conf')] : []),
      'new-session',
      '-d',
      '-s',
      terminalSessionName(asTerminalId(id)),
      '-c',
      group.cwd,
      '--',
      cmd,
    ]);
    first = false;
  }

  // The server serves dist/ + dist-server/ — build if they're missing.
  if (!fs.existsSync('dist/server/entry.mjs') || !fs.existsSync('dist-server/server/main.js')) {
    execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  }
}
