// Sweeps the test suites' residue out of os.tmpdir() and tmux.
//
// Why this exists: teardowns (afterAll/finally) never run when a run is
// killed or crashes, and several suites boot private servers whose tmux
// panes outlive them — most notoriously browser-theme's auto-opened agent
// tab, whose pi/npm install kept writing into the state dir mid-rm (the
// ENOTEMPTY teardown flake). Past runs have left thousands of /tmp
// mkdtemp dirs and dozens of live sessions behind. Every `cybermole-*`
// DIRECTORY in tmpdir is test/dev-tool residue (runtime code only uses
// `cybermole-*` as identifiers — MCP names, a datasource UID), so the rule
// is a wildcard with a protected list:
//
//   tmux — every `cybermole-*` socket in tmux's socket dir EXCEPT
//          `cybermole-itest` (the shared hermetic server, live during a
//          run) gets kill-server; absolute-socket servers under a swept
//          dir (terminal-ws's split mode) are killed by pid; on the
//          default `cybermole` socket — the operator's own — only
//          sessions whose every pane lives in a swept dir die (the
//          historical theme-spec leak shape), never the rest.
//   tmp  — every `cybermole-*` directory EXCEPT `cybermole-itest*` (the
//          hermetic workspace + its .sock, per-run rm'd by global-setup)
//          and `cybermole-dev-e2e-*` (the dev MCP's report dir, alive for
//          exactly the duration of the playwright run it belongs to).
//          Loose files are left alone.
//
// The e2e global-setup runs this before spawning its fixtures, so a
// crashed run self-heals on the next one. Standalone: `npm run
// test:cleanup` (or `node tools/test-cleanup.mjs --dry-run` to preview).
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP = os.tmpdir();
const DRY = process.argv.includes('--dry-run');
const QUIET = process.argv.includes('--quiet');

/** Names the tmp sweep must never touch. */
const PROTECTED_TMP = [/^cybermole-itest/, /^cybermole-dev-e2e-/];

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

const say = message => {
  if (!QUIET) console.log(message);
};

const sweptDir = name => name.startsWith('cybermole-') && !PROTECTED_TMP.some(re => re.test(name));

/** rm -rf tolerating a straggler writer: node's maxRetries leaves ENOTEMPTY
 *  un-retried on Linux (verified empirically), so the loop lives here. */
async function rmTree(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (attempt >= 10 || (e.code !== 'ENOTEMPTY' && e.code !== 'EBUSY')) return false;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/** The historical leak shape: fixture sessions parked on the operator's
 *  DEFAULT socket. A session dies only if every one of its panes sits in
 *  a swept tmp dir; anything else on that server is the operator's. */
function fixtureSessionsOnDefaultSocket() {
  const listed = run('tmux', [
    '-L',
    'cybermole',
    'list-panes',
    '-a',
    '-F',
    '#{session_name}\t#{pane_current_path}',
  ]);
  if (!listed.ok) return [];
  const panesBySession = new Map();
  for (const line of listed.out.split('\n')) {
    const [session, rawPath] = line.split('\t');
    if (!session || rawPath === undefined) continue;
    const cwd = rawPath.replace(/ \(deleted\)$/, '');
    const segment = path.relative(TMP, cwd);
    const underTmp = segment !== '' && !segment.startsWith('..') && !path.isAbsolute(segment);
    if (!panesBySession.has(session)) panesBySession.set(session, []);
    panesBySession.get(session).push(underTmp && sweptDir(segment.split(path.sep)[0]));
  }
  return [...panesBySession.entries()]
    .filter(([, panes]) => panes.length > 0 && panes.every(Boolean))
    .map(([session]) => session);
}

async function main() {
  // ---- tmux: private sockets ----
  const tmuxDir = path.join(TMP, `tmux-${os.userInfo().uid}`);
  let socketDirs = [];
  if (fs.existsSync(tmuxDir))
    socketDirs = fs
      .readdirSync(tmuxDir)
      .filter(name => name.startsWith('cybermole-') && name !== 'cybermole-itest');
  for (const name of socketDirs) {
    say(`tmux: kill-server -L ${name}`);
    if (DRY) continue;
    run('tmux', ['-L', name, 'kill-server']);
    // A server that died without cleanup (SIGKILL, crash) leaves its socket
    // file behind — the tmux dir accretes hundreds of stale names without
    // this. No live server is left holding it after kill-server.
    fs.rmSync(path.join(tmuxDir, name), { force: true });
  }

  // ---- tmux: absolute-socket servers under a swept dir (split mode) ----
  // Their socket file dies with the dir, but the server process lingers;
  // the command line names the socket path (-S), so find it there.
  const pgrep = run('pgrep', ['-f', `tmux .*-S ${TMP}/cybermole-`]);
  const strayServers = pgrep.ok
    ? pgrep.out
        .split('\n')
        .map(Number)
        .filter(pid => Number.isInteger(pid) && pid !== process.pid)
    : [];
  for (const pid of strayServers) {
    say(`tmux: SIGTERM stray absolute-socket server ${pid}`);
    if (!DRY) process.kill(pid, 'SIGTERM');
  }

  // ---- tmux: fixture sessions on the operator's default socket ----
  const fixtureSessions = fixtureSessionsOnDefaultSocket();
  for (const session of fixtureSessions) {
    say(`tmux: default socket, kill fixture session ${session}`);
    if (!DRY) run('tmux', ['-L', 'cybermole', 'kill-session', '-t', session]);
  }

  // ---- tmpdir: swept directories ----
  const swept = fs.existsSync(TMP)
    ? fs
        .readdirSync(TMP, { withFileTypes: true })
        .filter(e => e.isDirectory() && sweptDir(e.name))
        .map(e => path.join(TMP, e.name))
    : [];
  const dirsFound = swept.length;
  let dirsRemoved = 0;
  let dirsLeft = 0;
  for (const dir of swept) {
    if (DRY) {
      say(`tmp: would remove ${dir}`);
      continue;
    }
    if (await rmTree(dir)) dirsRemoved += 1;
    else {
      dirsLeft += 1;
      console.log(`test-cleanup: ${dir} still busy — left in place`);
    }
  }

  const summary =
    `test-cleanup: ${DRY ? 'dry run — would sweep ' : 'swept '}` +
    `${socketDirs.length} private tmux socket(s), ${strayServers.length} stray server(s), ` +
    `${fixtureSessions.length} default-socket fixture session(s), ` +
    `${DRY ? dirsFound : dirsRemoved} tmp dir(s) removed` +
    (dirsLeft > 0 ? `, ${dirsLeft} left busy` : '');
  console.log(summary);
  process.exitCode = dirsLeft > 0 ? 1 : 0;
}

await main();
