#!/usr/bin/env node
// The `cybermole-cli` bin: dispatches to verb groups (jobs.ts) over the
// internal API. Ships in the same image as the server, so it runs on both
// sides of the split; the workspace side is the point.
import { consoleOutput, type Output } from './output';
import { jobsGroupHelp, runJobsCommand } from './jobs';
// `cybermole-cli mcp` runs the jobs MCP server in-process (the pi template
// registers mcp.js directly; this is the dev convenience).
import { main as runMcpServer } from '../server/mcp';

const TOP_HELP = `cybermole-cli — the cybermole command line

The agent/human surface over the cybermole server's internal API: the
same jobs the /jobs page shows, driven from a terminal or a script.

Usage:
  cybermole-cli <group> <verb> [options]      run a verb (options go after it)
  cybermole-cli jobs <verb> --help            one verb's full documentation
  cybermole-cli --help                        this page

Groups:
  jobs          scheduled jobs — every action the /jobs page offers
  mcp           run the stdio jobs MCP server (for pi's tool list)

Common per-verb options:
  --json        print the server's raw JSON answer instead of the human
                rendering — stable for scripting (jq, agents)
  -h, --help    that verb's documentation

Socket:
  The verbs reach the server over its internal unix socket: $CYBERMOLE_SOCK
  when set, else /run/cybermole/cybermole.sock when /run/cybermole exists (the
  compose split's shared dir), else <state dir>/cybermole.sock. CYBERMOLE_SOCK
  empty = the server's internal API is off (the CLI then says so). A
  missing or unreachable socket is an error naming that knob.

Exit codes:
  0   success
  1   the operation failed — the server's error answer, or no server
      reachable on the socket
  2   usage error (unknown group/verb/option, missing or bad arguments)

Examples:
  cybermole-cli jobs list --json
  cybermole-cli jobs create --name nightly --schedule '0 4 * * *' --command 'npm test'
  cybermole-cli jobs run nightly
  cybermole-cli jobs runs nightly
  cybermole-cli jobs log nightly 1736395200000
  cybermole-cli jobs kill nightly 1736395200000`;

/** argv without node/bin. Never throws. */
export async function runCli(argv: string[], io: Output): Promise<number> {
  const [group, ...rest] = argv;
  if (group === undefined || group === '-h' || group === '--help') {
    io.out(TOP_HELP);
    return 0;
  }
  if (group === 'jobs') {
    if (rest.length === 0 || rest[0] === '-h' || rest[0] === '--help') {
      io.out(jobsGroupHelp());
      return 0;
    }
    return runJobsCommand(rest, io);
  }
  if (group === 'mcp') {
    // Runs over stdio until the client disconnects; never throws.
    await runMcpServer();
    return process.exitCode === 1 ? 1 : 0;
  }
  if (group.startsWith('-')) {
    io.err(`cybermole-cli: unknown option '${group}' — try: cybermole-cli --help`);
    return 2;
  }
  io.err(`cybermole-cli: unknown group '${group}' — try: cybermole-cli --help (today: jobs, mcp)`);
  return 2;
}

// Only when executed, so importing (unit tests) never runs a command.
if (require.main === module) {
  runCli(process.argv.slice(2), consoleOutput())
    .then(exitCode => {
      process.exitCode = exitCode;
    })
    .catch(err => {
      console.error(`cybermole-cli: ${(err as Error).message}`);
      process.exitCode = 1;
    });
}
