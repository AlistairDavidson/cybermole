#!/usr/bin/env node
// `npm run dev:server`: build, boot the compiled server on :3001, and rebuild
// and restart on changes to what the build reads (src/, server/, public/,
// the tsconfigs, astro.config.mjs). Pages needing services only render in
// this process. Docs and tests are ignored: every restart drops the open
// terminals.
//
// The build is staged so a failure changes nothing the running server sees:
// astro builds into .dist-watch (it cleans its outDir, and the running entry
// lazy-loads chunks from dist/), tsc emits into dist-server in place. Only
// when both succeed, and after the old server has drained, does the staged
// tree replace dist. Keep these steps in sync with `npm run build`.
//
// Editor noise (dotfiles, locks, vim's 4913 and swap files) is filtered, and
// events are debounced (250 ms) and coalesced while a cycle runs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = '3001';
const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(ROOT, '.dist-watch'); // gitignored, like dist/
const WATCH = [
  'src',
  'server',
  'public',
  'astro.config.mjs',
  'tsconfig.json',
  'tsconfig.server.json',
];
const QUIET_MS = 250;
const KILL_AFTER_MS = 10_000;

const log = message => console.log(`[dev:server] ${message}`);
const bin = name => path.join(ROOT, 'node_modules', '.bin', name);
const rm = p => fs.rmSync(p, { recursive: true, force: true });

const noise = basename =>
  basename.startsWith('.') ||
  basename.startsWith('#') ||
  basename === '4913' ||
  basename.endsWith('~') ||
  basename.endsWith('.swp') ||
  basename.endsWith('.swo');

/** SIGKILL after `killAfterMs` if it hangs. */
const exited = (proc, killAfterMs = KILL_AFTER_MS) =>
  new Promise(resolve => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const kill = setTimeout(() => proc.kill('SIGKILL'), killAfterMs);
    proc.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
  });

/** cwd ROOT: astro and tsc resolve the project from it. */
const run = (command, args) =>
  new Promise(resolve => {
    spawn(command, args, { stdio: 'inherit', cwd: ROOT }).once('exit', code => resolve(code ?? 1));
  });

/** Clean .dist-watch first: a crashed run may have left a partial. */
async function build() {
  rm(STAGE);
  const astro = await run(bin('astro'), ['build', '--outDir', STAGE]);
  if (astro !== 0) {
    rm(STAGE);
    return astro;
  }
  const tsc = await run(bin('tsc'), ['-p', 'tsconfig.server.json']);
  if (tsc !== 0) rm(STAGE); // dist-server re-emitted despite the error: the
  return tsc; // running server is unaffected; the next good build re-emits
}

/** Only with the old server gone, so nothing serves mismatched trees. */
function swap() {
  rm(DIST);
  fs.renameSync(STAGE, DIST);
}

let server = null;
let stopping = false; // the restart path owns the child's death
let busy = false; // a build/restart cycle is running
let queued = false; // a change landed mid-cycle — run another
let timer = null;

function boot() {
  server = spawn('node', ['dist-server/server/main.js'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, CYBERMOLE_PORT: PORT },
  });
  server.on('exit', (code, signal) => {
    if (stopping) return;
    log(`server exited on its own (code ${code ?? '?'}${signal ? `, signal ${signal}` : ''})`);
    process.exit(code ?? 1);
  });
}

/** SIGTERM is the graceful path (WS clients get 'restart'); SIGKILL after 10 s. */
async function restart() {
  if (server) {
    stopping = true;
    server.kill('SIGTERM');
    await exited(server);
    stopping = false;
  }
  swap();
  boot();
}

/** A failed build leaves the running server untouched. `fatal`: the first
 *  build, where a broken tree fails the command. */
async function cycle(fatal) {
  busy = true;
  let code;
  try {
    log(fatal ? 'building…' : 'change — rebuilding…');
    code = await build();
    if (code === 0) {
      if (fatal) log(`built — serving http://127.0.0.1:${PORT}`);
      else log(`rebuilt — restarting :${PORT} (reload its tabs)`);
      await restart();
    } else if (fatal) {
      process.exit(code);
    } else {
      log('build failed — the running server and its dist stay untouched; fix the error above');
    }
  } finally {
    busy = false;
  }
  if (queued) {
    queued = false;
    void cycle(false);
  }
}

function schedule() {
  if (busy) {
    queued = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    void cycle(false);
  }, QUIET_MS);
}

// The terminal also signals the server directly (same process group); its
// shutdown is idempotent, so either order works.
let exiting = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (exiting) return;
    exiting = true;
    clearTimeout(timer);
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    if (server && server.exitCode === null && !stopping) {
      stopping = true;
      server.kill('SIGTERM');
      exited(server).finally(() => process.exit(exitCode));
    } else {
      process.exit(exitCode);
    }
  });
}

for (const entry of WATCH) {
  const watched = path.join(ROOT, entry);
  if (!fs.existsSync(watched)) continue;
  fs.watch(watched, { recursive: true }, (_event, file) => {
    if (!file || noise(path.basename(file))) return;
    schedule();
  });
}

await cycle(true);
log(`serving http://127.0.0.1:${PORT} — watching ${WATCH.join(', ')}`);
