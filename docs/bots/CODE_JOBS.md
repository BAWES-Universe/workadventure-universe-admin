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
- Data goes in as files: `inputs` (read in `/mnt/files/in/<name>`) and `reads` (tools of the App the job was asked through, run by Orbit before the code and saved as `/mnt/files/in/<as>`). A read may never name a provider tool, and it passes the same gate every App tool has: the tool is on the Brick's list for this connection, a person confirmed it, it sits under "Looks something up", and that heading is set to run right away. A tool that is off, asks first, changes or sends, or was never confirmed is refused when the job starts (`not_allowed`), because a job has nobody to ask.
- Files go out in `/mnt/files/out/` (plain names, no folders).
- The workspace can reach the internet: the provider offers no way to narrow it.

## What really stops it

Every limit is a setting in **Limits → Apps: code jobs** (nothing is assumed in code; empty means code jobs are not offered): time, runs, code and data size, files and bytes kept per job, the most one person may keep, text kept, reads, jobs at once (per person and in all), jobs a day, the month's ceiling, days kept, wait for a result.

- Deadline: the run is stopped by deleting the workspace, not by trusting the wait.
- Cancel: the same. Files a worker was still copying when the cancel (or the sweep) ended the job are removed when that worker finishes.
- Sweep (every 30 s, in the Orbit process): ends a job past its deadline or with no heartbeat, retries deleting a workspace the provider would not delete (never "closed" on a guess), empties a job's printed result after the days kept (never the files: those belong to the person), and removes files whose owner no longer exists.
- After each job the provider's log for its session is read; any run that was not our code pauses code jobs (`provider_ran_tools`) until a super admin resumes them.

## Big App answers

Verified live (17 Nov 2026, Composio, throwaway sessions). With the provider's sandbox ON, an App answer past a threshold between about 37 KB and 85 KB is not returned: the Brick gets a short `data_preview` and an instruction to read the saved file with the sandbox, which an App link no longer offers. With the sandbox OFF (what App links now have) the provider returns every answer whole and ignores `sync_response_to_workbench`; 6 MB came back complete, with nothing offloaded or cut.

So the size is bounded by Orbit, by the Limit "Largest App answer given to a Brick" (200 KB when seeded; empty passes every answer on whole). An answer over it is never cut and never half passed on: the Brick gets `answer_too_large` saying the call ran and was counted once, how big the answer was, the Limit, and what to do (ask for less, or have a code job read all of it with `reads`; do not run it again). The job's own data Limit still applies to what a read brings in.

## No computer

A code job is not a computer and never makes, turns on or pays for one. When code jobs cannot run at all (not set, paused, ceiling reached, provider unavailable) the refusal tells a Brick with a computer to use it, and a Brick without one to tell the person the task needs a computer and that they can give the Brick one. Giving a computer stays the person's own step. A job is paid by the universe like any App step.

## What a result says

The result message says how many steps ran, which did not work, which never ran, how many App reads were done and what was kept. A run that was cut short is "started", never "ran", because nobody saw it end.

## Money

An estimate is reserved when the job starts and the meter event `codejob:<id>` is settled once, at what was used. A job whose meter line did not get written (the meter did not answer, or the process stopped between the two) has no `metered_at`, and the sweep writes it a minute after the job ended; the event id makes that safe to repeat. The sandbox is not billed by the provider today; the price is the saved App price or the built-in per-run figure, and the ceiling guards a future bill.

## Kept files (owned results)

A file a job leaves is kept as a durable result the person owns, in the shared store `lib/owned-results.ts` (table `owned_results`; the computer-job report-back work can use the same module). Each one records its owner, where it came from (`code_job` or `computer_job` plus the job id), the Brick that made it and the name it had, type, size, SHA-256 and access (`owner` only).

- Encrypted (AES-256-GCM) in Universe's own storage under `code-jobs/`, opened only by Orbit's route `/api/workbench/outputs/<id>` for the owner, as an attachment. The provider's copy is gone within a day and nothing depends on it.
- Kept until the owner deletes it. The job's record expiring (days kept), the job being cancelled, the Brick being deleted or the provider's copy expiring do not remove it. A Brick that is gone only changes the name shown to "A deleted Brick".
- The most one person may keep is the Limit "Result files one person may keep". A file that would go over is not kept; the Brick is told "your kept files are full: delete some to make room".
- Owner routes: `GET /api/workbench/outputs` (list), `DELETE /api/workbench/outputs/<id>` (the stored file goes first; if it cannot be removed the result stays listed), `POST /api/workbench/outputs/<id>/artifact` (see below).
- Nothing publishes a result by itself. Publishing is a separate action by the owner: it makes an Artifact "Just you" (markdown, svg or html files only, within the artifact size Limit) with the Brick and result as provenance; the kept file stays. Sharing then goes through the normal artifact sharing.
- Results whose owner account is gone are removed by the sweep.

## Not covered

- Only markdown, svg and html results can become Artifacts; Artifacts have no generic file kind.
- A deleted Brick's name is replaced at read time on the results list. An Artifact made from a result before its Brick was deleted keeps the Brick's name until the existing deleted-Brick flow is extended to artifacts.
- A crash between opening the provider session and saving its id leaves a tool-less session at the provider (the provider has no list endpoint to find it).
- One cell is limited by the provider to 180 seconds; that is not configurable.
- `enable_tool_execution` is not in the provider's docs but is accepted and read back.
