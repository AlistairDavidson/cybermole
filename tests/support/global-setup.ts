// Hermetic workspace for the e2e run. The webServer boots first, which is
// fine: it opens the state db and tmux socket lazily.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setCredential } from '../../src/lib/platform/auth';
import { StateDb, qb } from '../../src/lib/platform/db';
import type { DatabaseReadResult } from '@cybermole/app-kit';
import { Apps } from '../../src/lib/apps/apps';
import { Workspaces } from '../../src/lib/terminals/workspaces';
import { terminalSessionName } from '../../src/lib/terminals/tmux';
import { asAppId, asTerminalId } from '@cybermole/app-kit';
import {
  AGENT_MARKER,
  APPS_ROOT,
  MARKER,
  PASSWORD,
  TMUX_SOCKET,
  USERNAME,
  WORKSPACE,
  writeSharedSessionCookie,
} from './env';

/** Rebuilt when dist/ is missing or older than its sources; every real
 *  build runs the self-containment gate. */
function buildFixtureApp(): void {
  const fixture = path.resolve(__dirname, '..', 'fixtures', 'app-fixture');
  const entry = path.join(fixture, 'dist', 'server', 'entry.mjs');
  const newestUnder = (dir: string): number =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? newestUnder(p) : [fs.statSync(p).mtimeMs];
      })
      .reduce((a, b) => Math.max(a, b), 0);
  const sources = [
    newestUnder(path.join(fixture, 'src')),
    newestUnder(path.join(fixture, 'public')),
    ...['app.json', 'astro.config.mjs', 'package.json', 'setup-node-modules.mjs'].map(
      f => fs.statSync(path.join(fixture, f)).mtimeMs,
    ),
  ].reduce((a, b) => Math.max(a, b), 0);
  if (fs.existsSync(entry) && fs.statSync(entry).mtimeMs >= sources) return; // fresh: skip fast
  if (!fs.existsSync(path.join(fixture, 'node_modules', '.bin', 'astro'))) {
    execFileSync('node', ['setup-node-modules.mjs'], { cwd: fixture, stdio: 'inherit' });
  }
  execFileSync(path.join(fixture, 'node_modules', '.bin', 'astro'), ['build'], {
    cwd: fixture,
    stdio: 'inherit',
  });
  execFileSync(
    'node',
    [path.resolve(__dirname, '..', '..', 'tools', 'check-app-selfcontained.mjs'), entry],
    {
      stdio: 'inherit',
    },
  );
}

export default async function globalSetup(): Promise<void> {
  buildFixtureApp();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  // The server reads the credential row per attempt and opens the db lazily.
  const db = new StateDb(path.join(WORKSPACE, 'cybermole.db'));
  const saved = setCredential(db, USERNAME, PASSWORD);
  if (!saved.ok) throw new Error(`global-setup: ${saved.errorMessage}`);

  // New tabs run a banner plus a shell. CYBERMOLE_COMMAND is whitespace-split,
  // so it must be one path; the `agent` argument gives the auto-opened agent
  // tab a distinct banner.
  const cmd = path.join(WORKSPACE, 'cmd.sh');
  fs.writeFileSync(
    cmd,
    `#!/bin/sh\nif [ "$1" = "agent" ]; then echo '${AGENT_MARKER}'; else echo '${MARKER}'; fi\nexec /bin/sh\n`,
  );
  fs.chmodSync(cmd, 0o755);

  // The fixture tree, through the real domains: one app, two console
  // workspaces, one app workspace. Rows only; which tabs are live is decided
  // by the tmux sessions below. Each create auto-opens the first tab, so
  // `titles` lists only the extras (scratch's dead-tab fixture).
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
    appsRoot: APPS_ROOT,
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
    // Read back the auto-opened tab so the list starts with it.
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

  // Kill a leftover test tmux server before starting the live fixtures, and
  // wait until it's gone: a dying server answers "server exited
  // unexpectedly". list-sessions never forks a server of its own.
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* no server running */
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

  // Live fixtures are real t-<uuid> sessions at their workspace cwd.
  // scratch's 'build' tab stays dead on purpose. The first tab is live
  // because it's auto-selected at login. -f on the first session loads the
  // app's tmux.conf, whose terminal-overrides the backfill tests rely on.
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
      ...(first ? ['-f', path.resolve(__dirname, '..', '..', 'runtime', 'tmux.conf')] : []),
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

  // One sign-in for the whole run: the 10/15-min login budget is tight, so
  // the apps specs reuse this cookie (env.ts). Best-effort: on failure the
  // first spec signs in itself.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:3470/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      const cookie = res.headers.get('set-cookie');
      if (res.status === 200 && cookie !== null) {
        writeSharedSessionCookie(cookie.split(';')[0]);
        break;
      }
    } catch {
      /* the webServer may still be coming up */
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
