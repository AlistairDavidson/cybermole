#!/usr/bin/env node
// dev-server-watch.mjs — `npm run dev:server`: build once, boot the
// compiled server on :3001, then keep it current. The data pages
// (/settings, /jobs, /management) render only inside that process
// (assertWebPiLocals in their frontmatter — astro dev's own render has
// no services), so its build inputs changing IS the dev loop for them.
//
// What it watches: exactly what the build reads — src/ (pages,
// components, lib, schemas), server/ (the gate), public/ (copied into
// the client build), the two tsconfigs, astro.config.mjs. Docs, tests
// and package.json deliberately stay out: they change nothing the
// server serves, and every restart drops the open terminals (the WS
// bridge lives in the restarted process).
//
// The build is STAGED, and a failed one changes nothing the running
// server sees. The astro half builds into .dist-watch (astro cleans its
// outDir up front, and the running entry lazy-loads route chunks from
// dist/server/chunks at render time — an in-place failed build breaks
// every page not yet rendered), the tsc half emits into dist-server in
// place (tsc never cleans). Only when BOTH succeed does the staged tree
// swap in for dist — after the old server has exited (it serves its old
// tree through its graceful drain; nothing serves while the trees
// mismatch) — followed by the new boot. These steps are npm run build's;
// they must stay in sync with it (package.json keeps its plain form —
// e2e, prepack and production build in place, with nothing serving).
//
// The port is forced to 3001, as the old one-liner forced it: astro
// dev's proxy targets it by default (WEB_PI_DEV_API retargets).
// Everything else is inherited from this process's environment.
//
// fs.watch noise (inotify) is filtered — dotfiles, `#`-prefixed locks,
// editor swap (vim's 4913, *.swp/*.swo, *~): opening a file in vim
// alone must not cost every open terminal a restart. Events are
// debounced (250 ms quiet) and coalesced while a cycle runs, so a save
// that touches several files is one rebuild.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = '3001';
const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(ROOT, '.dist-watch'); // gitignored, like dist/
const WATCH = ['src', 'server', 'public', 'astro.config.mjs', 'tsconfig.json', 'tsconfig.server.json'];
const QUIET_MS = 250;
const KILL_AFTER_MS = 10_000;

const log = (message) => console.log(`[dev:server] ${message}`);
const bin = (name) => path.join(ROOT, 'node_modules', '.bin', name);
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

/** A noise event (editor scratch): dotfiles, lock files, vim's 4913, swap. */
const noise = (basename) =>
  basename.startsWith('.') || basename.startsWith('#') || basename === '4913'
  || basename.endsWith('~') || basename.endsWith('.swp') || basename.endsWith('.swo');

/** Resolve when the process exits — SIGKILL after `killAfterMs` if it hangs. */
const exited = (proc, killAfterMs = KILL_AFTER_MS) => new Promise((resolve) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
  const kill = setTimeout(() => proc.kill('SIGKILL'), killAfterMs);
  proc.once('exit', () => { clearTimeout(kill); resolve(); });
});

/** A build step's exit code (0 on success), with its output streamed.
 *  cwd: ROOT — astro and tsc resolve the project from the cwd. */
const run = (command, args) => new Promise((resolve) => {
  spawn(command, args, { stdio: 'inherit', cwd: ROOT }).once('exit', (code) => resolve(code ?? 1));
});

/** Build, staged: astro into .dist-watch (clean first — a crashed run
 *  may have left a partial), tsc into dist-server. */
async function build() {
  rm(STAGE);
  const astro = await run(bin('astro'), ['build', '--outDir', STAGE]);
  if (astro !== 0) { rm(STAGE); return astro; }
  const tsc = await run(bin('tsc'), ['-p', 'tsconfig.server.json']);
  if (tsc !== 0) rm(STAGE); // dist-server re-emitted despite the error: the
  return tsc;               // running server is unaffected; the next good build re-emits
}

/** Move the staged build in as dist. Only called with the old server
 *  gone — nothing serves while the trees swap. */
function swap() {
  rm(DIST);
  fs.renameSync(STAGE, DIST);
}

let server = null;
let stopping = false; // the restart path owns the child's death
let busy = false;     // a build/restart cycle is running
let queued = false;  // a change landed mid-cycle — run another
let timer = null;

/** Boot the fresh build (the child logs its own 'web-pi listening' line). */
function boot() {
  server = spawn('node', ['dist-server/server/main.js'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, WEB_PI_PORT: PORT },
  });
  server.on('exit', (code, signal) => {
    if (stopping) return;
    log(`server exited on its own (code ${code ?? '?'}${signal ? `, signal ${signal}` : ''})`);
    process.exit(code ?? 1);
  });
}

/** Stop the old server (SIGTERM is its graceful path: every WS client
 *  gets 'restart', terminals close, it drains out within its deadline;
 *  SIGKILL after 10 s if it hangs), then swap in the new tree, then boot. */
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

/** One cycle: build, and on success swap + serve — a failed build
 *  leaves the running server and its dist untouched. `fatal`: the FIRST
 *  build — a broken tree fails the command, like the old `&&` chain did. */
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
  if (queued) { queued = false; void cycle(false); }
}

function schedule() {
  if (busy) { queued = true; return; }
  clearTimeout(timer);
  timer = setTimeout(() => { void cycle(false); }, QUIET_MS);
}

// Ctrl-C / TERM: take the server down with us. A terminal sends the
// signal to the whole process group, so the server also gets it directly
// — its shutdown path is idempotent; either order works.
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
