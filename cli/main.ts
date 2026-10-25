#!/usr/bin/env node
// main.ts — the `cybermole-cli` bin (task/jobs-cli, docs/plans/jobs-agent-plan.md §5):
// the agent/human-facing surface over the server's internal jobs API.
// A thin dispatcher — group → verb → the socket client layer — plus the
// top-level help; the verb logic and its documentation live in jobs.ts.
// The bin sits beside `cybermole` (the server) and `cybermole-set-password` in
// package.json and ships in the same image, so it runs in BOTH
// containers of the split — the workspace side is its whole point.
// Runs with zero new runtime deps (node:http over the unix socket).
import { consoleOutput, type Output } from './output';
import { jobsGroupHelp, runJobsCommand } from './jobs';
// plan §6: `cybermole-cli mcp` runs the stdio jobs MCP server (server/mcp.ts).
// Imported, never re-executed: mcp.ts's self-guard runs only when IT is
// argv[1] — the runtime/pi-agent-dir/ template registers the same server via the absolute
// `node /opt/cybermole/dist-server/server/mcp.js` form (PATH-independent);
// this subcommand is the dev-shape convenience.
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

/** Run one command line (argv without node/bin). Never throws — every
 *  failure is a printed message and an exit code. Importable (unit
 *  tests drive verbs in-process); the bin entry point is the guard
 *  below. */
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
    // The MCP server runs over stdio until its client disconnects;
    // runMcpServer never throws (its own catch sets process.exitCode).
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

// The bin entry: run only when executed, so importing this module (unit
// tests, the MCP subcommand of plan §6) never triggers a command.
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
