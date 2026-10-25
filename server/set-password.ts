#!/usr/bin/env node
// Set or replace the single login credential (interactive or piped:
// printf 'user\npass\npass\n' | node dist-server/server/set-password.js).
// --if-unset: no-op when a credential exists (dev's first-boot seed). It skips
// the 8-char minimum, which only guards human typos; login enforces none.
// Plain console.* on purpose: this is interactive CLI output.
import * as readline from 'node:readline';
import { Auth, setCredential } from '../src/lib/platform/auth';
import { StateDb } from '../src/lib/platform/db';
import { ENV } from '../src/lib/platform/env';

const stateDb = new StateDb(ENV.CYBERMOLE_DB_FILE);

// Print the prompt before muting output, or the prompt is swallowed too.
function askInteractive(
  out: NodeJS.WriteStream,
  rl: readline.Interface,
  q: string,
  mute: boolean,
): Promise<string> {
  return new Promise(resolve => {
    if (!mute) {
      rl.question(q, a => resolve(a));
      return;
    }
    const write = out.write.bind(out);
    write(q);
    out.write = (s: string) => {
      if (s === '\r\n' || s === '\n') write(s);
      return true;
    };
    rl.question('', a => {
      out.write = write;
      out.write('\n');
      resolve(a);
    });
  });
}

// Read all lines up front: sequential rl.question() races when a pipe delivers them in one chunk.
function readPiped(): Promise<string[]> {
  return new Promise(resolve => {
    const lines: string[] = [];
    let buf = '';
    process.stdin.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    });
    process.stdin.on('end', () => {
      if (buf) lines.push(buf.replace(/\r$/, ''));
      resolve(lines);
    });
  });
}

void (async (): Promise<void> => {
  // An unreadable db is an error, never "unset".
  const ifUnset = process.argv.includes('--if-unset');
  let username: string, pw: string, pw2: string;
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    username = (await askInteractive(process.stdout, rl, 'Username: ', false)).trim();
    pw = await askInteractive(process.stdout, rl, 'Password (input hidden): ', true);
    pw2 = await askInteractive(process.stdout, rl, 'Repeat password: ', true);
    rl.close();
  } else {
    const lines = await readPiped();
    username = (lines[0] ?? '').trim();
    pw = lines[1] ?? '';
    pw2 = lines[2] ?? '';
  }
  if (!username) {
    console.error('username required');
    process.exit(1);
  }
  if (ifUnset) {
    const configured = new Auth(stateDb).configured();
    if (!configured.ok) {
      console.error(configured.errorMessage);
      process.exit(1);
    }
    if (configured.data.value) process.exit(0);
  }
  if (!pw || (!ifUnset && pw.length < 8)) {
    console.error(ifUnset ? 'password required' : 'password must be >= 8 chars');
    process.exit(1);
  }
  if (pw !== pw2) {
    console.error('passwords do not match');
    process.exit(1);
  }
  const saved = setCredential(stateDb, username, pw);
  if (!saved.ok) {
    console.error(saved.errorMessage);
    process.exit(1);
  }
  console.log('written:', ENV.CYBERMOLE_DB_FILE);
})();
