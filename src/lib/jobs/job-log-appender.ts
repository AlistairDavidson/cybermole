#!/usr/bin/env node
// Capped tee for job run logs: stdin passes through to stdout (the tmux pane
// the console shows) and is appended to <logPath> up to <maxBytes>, then one
// marker line. It keeps draining stdin past the cap and never exits early:
// closing the pipe would SIGPIPE the job and corrupt its captured exit code.
// Zero deps: it runs inside the workspace container's tmux session.
import * as fs from 'node:fs';

const USAGE = 'usage: node job-log-appender.js <logPath> <maxBytes>';

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

  // An unopenable log loses output but the run goes on, so still drain stdin.
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
    // Passthrough first, always: the cap must never blank the pane. A dead
    // pane's write failure is ignored.
    writeAll(1, chunk);
    if (fd === null || marked || chunk.length === 0) return;
    const room = maxBytes - written;
    if (room <= 0) {
      // A failed marker write stops touching the file, rather than retry into a garbled marker.
      if (writeAll(fd, markerLine(maxBytes))) marked = true;
      else fd = null;
      return;
    }
    const keep = chunk.subarray(0, room);
    if (!writeAll(fd, keep)) {
      fd = null;
      return;
    }
    written += keep.length;
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
