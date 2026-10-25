#!/usr/bin/env node
// job-log-appender.ts — plan §8 (docs/plans/jobs-agent-plan.md): the write-time
// cap on job run logs. The run wrapper (runCommandArgv, src/lib/jobs.ts)
// pipes the job's output through this instead of tee:
//
//     node job-log-appender.js <logPath> <maxBytes>
//
// A capped TEE, not a sink: stdin passes through to stdout (the tmux
// pane — the console's live run view — must keep showing the output) and
// is appended to <logPath> until <maxBytes> bytes are written; past the cap
// further bytes — while stdin KEEPS BEING DRAINED until the job closes
// it. Never exit before stdin ends: closing the read end early would
// SIGPIPE the job mid-run, killing it or corrupting the exit code the
// wrapper captures inside the pipeline (post-run truncation was rejected
// for the same reason — a chatty or runaway job must not be able to fill
// the disk while it runs). Plain node, zero deps: it runs as a child of
// the wrapper, inside the WORKSPACE container's tmux session — both
// containers of the split ship the same image, so the web side's
// module-relative path (jobs.ts) is valid where this executes.
import * as fs from 'node:fs';

const USAGE = 'usage: node job-log-appender.js <logPath> <maxBytes>';

/** One line, written once past the cap, so a reader knows the log is a
 *  prefix — and where it stopped. */
const markerLine = (atBytes: number): Buffer =>
  Buffer.from(`[truncated at ${atBytes} bytes]\n`, 'utf8');

/** Write the whole buffer (writeSync may write short). */
function writeAll(fd: number, buf: Buffer): boolean {
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch {
      return false; // ENOSPC et al: stop writing, keep draining
    }
  }
  return true;
}

function main(): void {
  const [logPath, maxRaw] = process.argv.slice(2);
  const argsOk = logPath !== undefined && maxRaw !== undefined && /^\d+$/.test(maxRaw);
  const maxBytes = argsOk ? Number(maxRaw) : 0;

  // An unopenable log degrades exactly like a failed tee did pre-§8:
  // the run goes on (output lost, exit file still written by the
  // wrapper) — so this still never exits before stdin ends.
  let fd: number | null = null;
  if (!argsOk) {
    process.stderr.write(`job-log-appender: bad arguments — ${USAGE}\n`);
    process.exitCode = 2;
  } else {
    try {
      fd = fs.openSync(logPath, 'a');
    } catch (err) {
      process.stderr.write(
        `job-log-appender: could not open ${logPath}: ${(err as Error).message}\n`,
      );
      process.exitCode = 1;
    }
  }

  let written = 0;
  let marked = false;
  process.stdin.on('data', (chunk: Buffer) => {
    // Passthrough FIRST, always, capped or not: this is a capped tee, not
    // a sink. The pane the tmux session displays (the console's live run
    // view, /?run=) is this process's stdout — the file cap must never
    // blank it. A stdout write failure (dead pane) is ignored: the run
    // goes on, only the file side matters then.
    writeAll(1, chunk);
    if (fd === null || marked || chunk.length === 0) return; // drain only
    const room = maxBytes - written;
    if (room <= 0) {
      // Already at the cap and more arrived: mark once, then discard. A
      // failed marker write (ENOSPC) stops touching the file for good —
      // never retry it into a partial, garbled marker on a later chunk.
      if (writeAll(fd, markerLine(maxBytes))) marked = true;
      else fd = null;
      return;
    }
    const keep = chunk.subarray(0, room);
    if (!writeAll(fd, keep)) {
      fd = null; // write failure: no marker, just stop touching the file
      return;
    }
    written += keep.length;
    // A chunk that straddles the cap marks here; a failed marker write
    // (ENOSPC) stops touching the file for good — same policy as above.
    if (chunk.length > room) {
      if (writeAll(fd, markerLine(maxBytes))) marked = true;
      else fd = null;
    }
  });
  process.stdin.on('end', () => {
    if (fd !== null) fs.closeSync(fd);
  });
  process.stdin.on('error', err => {
    if (fd !== null) fs.closeSync(fd);
    process.stderr.write(`job-log-appender: stdin: ${err.message}\n`);
    process.exitCode = 1;
  });
}

main();
