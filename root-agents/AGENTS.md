# AGENTS.md — standing instructions for the agent working at this root

This is the workspace root of a web-pi install, and its terminals are
where the root agent works. **Scheduled or recurring work belongs in
web-pi jobs, not ad-hoc terminal sessions**: a job (name + 5-field cron
schedule, local time + one-line shell command, optionally tagged with an
app) survives reboots and restarts, keeps run history with exit codes,
and writes a durable per-run log. Fire one manually with
`webpi jobs run <name>`; `webpi jobs --help` documents every verb.

**Fired means started, not finished.** `run` answering ok means the run
session opened and the command is starting — the outcome lands in the
run history when the server's tick observes the finish (≤30 s after the
end). Poll `webpi jobs runs <name>` and **check the EXIT code before
declaring success**: '?' = not observed yet, keep waiting. A refused run
(`run_active`, exit 1) means the previous run is still live — wait, or
kill it. One run's log: `webpi jobs log <name> <firedAt>` (the newest
1 MiB); the firedAt (epoch ms) is the run's identity — copy it from
`runs`.

## The tool surface

The CLI (every verb takes `--json` for the server's raw answer):

    webpi jobs list [-a <app-slug>]              the definitions, next fires, live runs
    webpi jobs runs <name>                       run history (firedAt = run identity)
    webpi jobs log <name> <firedAt>              one run's log tail (newest 1 MiB)
    webpi jobs create --name <n> --schedule '<cron>' --command '<cmd>' [--app <app-id>]
    webpi jobs set <name> [--schedule '<cron>'] [--command '<cmd>'] [--app <app-id> | --clear-app]
    webpi jobs delete <name>                     drop the job, its history and logs
    webpi jobs run <name>                        fire now (409 while one is live)
    webpi jobs kill <name> <firedAt>             kill the job's live run
    webpi jobs validate [--schedule '<cron>'] [--command '<cmd>']

    webpi jobs create --name nightly --schedule '0 4 * * *' --command 'npm test'
    webpi jobs run nightly
    webpi jobs runs nightly
    webpi jobs log nightly 1736395200000

The same surface is in-session MCP tools — **webpi-jobs**, registered
for every pi session by the agent-dir template's `mcp.json`:
`jobs_list`, `jobs_create`, `jobs_set`, `jobs_delete`, `jobs_runs`,
`jobs_log`, `jobs_run_now`, `jobs_kill`, `jobs_validate`, `apps_list`.
If that template is updated (a redeploy), run `/reload` inside pi to
pick it up.

## Trust

Jobs are the root agent's to manage. App-level agents working in trees
below this directory also read this file by upward walk — accepted usage
(v1: one uid; a usage convention, not enforcement).
