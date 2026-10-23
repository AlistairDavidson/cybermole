# AGENTS.md — standing instructions for the agent working at this root

This is the workspace root of a cybermole install, and its terminals are
where the root agent works. **Scheduled or recurring work belongs in
cybermole jobs, not ad-hoc terminal sessions**: a job (name + 5-field cron
schedule, local time + one-line shell command, optionally tagged with an
app) survives reboots and restarts, keeps run history with exit codes,
and writes a durable per-run log. Fire one manually with
`cybermole-cli jobs run <name>`; `cybermole-cli jobs --help` documents every verb.

**Fired means started, not finished.** `run` answering ok means the run
session opened and the command is starting — the outcome lands in the
run history when the server's tick observes the finish (≤30 s after the
end). Poll `cybermole-cli jobs runs <name>` and **check the EXIT code before
declaring success**: '?' = not observed yet, keep waiting. A refused run
(`run_active`, exit 1) means the previous run is still live — wait, or
kill it. One run's log: `cybermole-cli jobs log <name> <firedAt>` (the newest
1 MiB); the firedAt (epoch ms) is the run's identity — copy it from
`runs`.

## The tool surface

The CLI (every verb takes `--json` for the server's raw answer):

    cybermole-cli jobs list [-a <app-slug>]              the definitions, next fires, live runs
    cybermole-cli jobs runs <name>                       run history (firedAt = run identity)
    cybermole-cli jobs log <name> <firedAt>              one run's log tail (newest 1 MiB)
    cybermole-cli jobs create --name <n> --schedule '<cron>' --command '<cmd>' [--app <app-id>]
    cybermole-cli jobs set <name> [--schedule '<cron>'] [--command '<cmd>'] [--app <app-id> | --clear-app]
    cybermole-cli jobs delete <name>                     drop the job, its history and logs
    cybermole-cli jobs run <name>                        fire now (409 while one is live)
    cybermole-cli jobs kill <name> <firedAt>             kill the job's live run
    cybermole-cli jobs validate [--schedule '<cron>'] [--command '<cmd>']

    cybermole-cli jobs create --name nightly --schedule '0 4 * * *' --command 'npm test'
    cybermole-cli jobs run nightly
    cybermole-cli jobs runs nightly
    cybermole-cli jobs log nightly 1736395200000

The same surface is in-session MCP tools — **cybermole-jobs**, registered
for every pi session by the agent-dir template's `mcp.json`:
`jobs_list`, `jobs_create`, `jobs_set`, `jobs_delete`, `jobs_runs`,
`jobs_log`, `jobs_run_now`, `jobs_kill`, `jobs_validate`, `apps_list`.
If that template is updated (a redeploy), run `/reload` inside pi to
pick it up.

## Trust

Jobs are the root agent's to manage. App-level agents working in trees
below this directory also read this file by upward walk — accepted usage
(v1: one uid; a usage convention, not enforcement).
