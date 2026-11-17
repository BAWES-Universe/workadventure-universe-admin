# Code jobs for Apps

A Brick can run a short Python script in a separate, temporary workspace, to transform or analyse data and to make files. This replaces the provider's own sandbox tools on an App link: those two tools are taken out of every tool list and refused when called (alone or inside a batch), because a run sent that way has no deadline, no Limits, no cancel and could reach the person's accounts.

## What the Brick sees

Three tools, added by Orbit to the first page of an App's tool list (only while code jobs can run: the provider side is on, every Limit is set, not paused):

| Tool | What it does |
| --- | --- |
| `UNIVERSE_CODE_JOB_START` | `{ code | steps, inputs?, reads? }`. Answers at once with a `jobId`. |
| `UNIVERSE_CODE_JOB_RESULT` | `{ jobId }`. Waits up to "How long to wait for a result", then says it is still running; ask again. |
| `UNIVERSE_CODE_JOB_CANCEL` | `{ jobId }`. Deletes the workspace. |

The bot server gives up on a call to a link at 60 seconds, so a job is always started and asked for separately. The same call id gives the same job, never a second workspace or a second charge.

## What a job can reach

- A workspace made for the one job, in its own provider session: no Apps, no tools run from inside it, no raw requests, no connection tools, Instant off. The session is read back and trusted only if every one of these is as asked; otherwise it is deleted and the job does not run.
- Data goes in as files: `inputs` (read in `/mnt/files/in/<name>`) and `reads` (tools of the App the job was asked through, run by Orbit before the code and saved as `/mnt/files/in/<as>`). A read may never name a provider tool.
- Files go out in `/mnt/files/out/` (plain names, no folders).
- The workspace can reach the internet: the provider offers no way to narrow it.

## What really stops it

Every limit is a setting in **Limits → Apps: code jobs** (nothing is assumed in code; empty means code jobs are not offered): time, runs, code and data size, files and bytes kept, text kept, reads, jobs at once (per person and in all), jobs a day, the month's ceiling, days kept, wait for a result.

- Deadline: the run is stopped by deleting the workspace, not by trusting the wait.
- Cancel: the same.
- Sweep (every 30 s, in the Orbit process): ends a job past its deadline or with no heartbeat, retries deleting a workspace the provider would not delete (never "closed" on a guess), and removes results and files after the days kept.
- After each job the provider's log for its session is read; any run that was not our code pauses code jobs (`provider_ran_tools`) until a super admin resumes them.

## Money

An estimate is reserved when the job starts and the meter event `codejob:<id>` is settled once, at what was used. The sandbox is not billed by the provider today; the price is the saved App price or the built-in per-run figure, and the ceiling guards a future bill.

## Kept files

Encrypted (AES-256-GCM) in Universe's own storage under `code-jobs/`, opened only by Orbit's own route (`/api/workbench/outputs/<id>`) for the job's owner, as an attachment. The provider's copy is gone within a day.

## Not covered

- A crash between opening the provider session and saving its id leaves a tool-less session at the provider (the provider has no list endpoint to find it).
- One cell is limited by the provider to 180 seconds; that is not configurable.
- `enable_tool_execution` is not in the provider's docs but is accepted and read back.
