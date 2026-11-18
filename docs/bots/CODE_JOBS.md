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

Every limit is a setting in **Limits → Apps: code jobs** (nothing is assumed in code; empty means code jobs are not offered): time, runs, code and data size, files and bytes kept per job, the most one person may keep, text kept, reads, jobs at once (per person and in all), jobs a day, the month's ceiling, days kept, wait for a result. A row whose range starts at 0 can be saved as 0 ("Other" accepts a typed 0 there); "Days kept" and "Largest App answer given to a Brick" can be emptied again with the "Not set" choice.

- Deadline: the run is stopped by deleting the workspace, not by trusting the wait.
- Cancel: the same. A job that is cancelled, times out or is lost keeps no files: its files are removed when it ends, and also when a worker was still copying them (removed when that worker finishes). A job that finished (succeeded, or the code failed) keeps its files until the owner deletes them.
- A run is claimed on the job's own row and only while the job is going, so a cancel and a run being sent settle one way: the run is claimed and charged, or refused and never sent. The job is settled from the counters read in the same step as its move to the end.
- Sweep (every 30 s, in the Orbit process): ends a job past its deadline or with no heartbeat, retries deleting a workspace the provider would not delete (never "closed" on a guess), empties a job's printed result after the days kept (never the files: those belong to the person), and removes files whose owner no longer exists. It also removes any file a cancelled, timed out or lost job still has (a removal that failed when it ended), and says a workspace id again when it could not be written down because the job had already ended.
- After each job the provider's log for its session is read; any run that was not our code pauses code jobs (`provider_ran_tools`) until a super admin resumes them.

## Big App answers

Verified live (17 Nov 2026, Composio, throwaway sessions). With the provider's sandbox ON, an App answer past a threshold between about 37 KB and 85 KB is not returned: the Brick gets a short `data_preview` and an instruction to read the saved file with the sandbox, which an App link no longer offers. With the sandbox OFF (what App links now have) the provider returns every answer whole and ignores `sync_response_to_workbench`; 6 MB came back complete, with nothing offloaded or cut.

So the size is bounded by Orbit, by the Limit "Largest App answer given to a Brick" (200 KB when seeded; empty passes every answer on whole). An answer over it is never cut and never half passed on: the Brick gets `answer_too_large` saying the call ran and was counted once, how big the answer was, the Limit, and what to do (ask for less, or have a code job read all of it with `reads`; do not run it again). The job's own data Limit still applies to what a read brings in.

## No computer

A code job is not a computer and never makes, turns on or pays for one. When code jobs cannot run at all (not set, paused, ceiling reached, provider unavailable) the refusal tells a Brick with a computer to use it, and a Brick without one to tell the person the task needs a computer and that they can give the Brick one. Giving a computer stays the person's own step. A job is paid by the universe like any App step.

## What a result says

The result message says how many steps ran, which did not work, which never ran, how many App reads were done and what was kept. A run that was cut short is "started", never "ran", because nobody saw it end.

## Money

The person's code is sent exactly as written. The folder for files is made by a small run of its own before the first step; it is a real run at the provider, so it is reserved, settled and metered like a step (`prepared_runs`), but it is never shown as one of the person's steps. The listing of a job's files stops once the number kept plus 50 are in hand, and one more is asked for so "(more files)" is only said when there really are more.

An estimate is reserved when the job starts and the meter event `codejob:<id>` is settled once, at what was used. A job whose meter line did not get written (the meter did not answer, or the process stopped between the two) has no `metered_at`, and the sweep writes it a minute after the job ended; the event id makes that safe to repeat. The sandbox is not billed by the provider today; the price is the saved App price or the built-in per-run figure, and the ceiling guards a future bill.

## The gate before it opens, and what is owed while a delete is unsure

Three things are checked before code jobs are offered and again on every job (Brief I of the final billing consensus):

- **The provider's own limits.** A job's workspace is made restricted and read back so; if it does not match, nothing runs and the workspace is deleted. When the provider refuses to make one because of its own limit (429 too many requests, 402 no funds) the job ends `provider_limit`, nothing ran, nothing is charged, and the Brick is told it is the provider's limit, not a failure of the code.
- **Nested runs.** After each job the provider's log for its session is read for runs that were not ours; any run pauses code jobs (`provider_ran_tools`). The log is read **even when the delete is not confirmed** (a workspace that would not be deleted may still be running something), and read again once the delete is confirmed. `nested_checked_at` is set only by a read after the delete was confirmed; until then the sweep keeps trying. A pause limits further loss but cannot undo a fee already incurred, which is why the next point exists.
- **A workspace whose delete is not confirmed** (`provider_state` open or unknown) may still be running code. It counts as a job running (against jobs at once, for the person and in all) and as owed at what was **held**, not at what the job settled at, until the delete is confirmed. With a failing provider the jobs-at-once Limit therefore stops new work by itself.

## Apps line of the Budget

Code jobs are the third Apps line (with connected Apps and Instant Apps). The Budget page only shows and saves what is enforced here, under the keys the Limits already have: the month's ceiling is `exposureCeilingMicros`, jobs at once are `atOnceAll` and `atOncePerPerson`, jobs a day `jobsPerPersonPerDay`. Nothing is renamed. `readCodeJobsBudget()` (`lib/workbench/budget.ts`, also under `budget` in `GET /api/admin/workbench`) gives the money side for the page: settled, held, owed while a delete is unconfirmed, what counts against the ceiling, jobs running, workspaces not confirmed deleted, logs not yet checked, the price of a run, runs this month, paused and why, and a straight-line forecast with its sample period and time (a burst can still reach the ceiling sooner). Whichever of this PR and the Budget page merges second adds the line to the page.

## Kept files (owned results)

A file a job leaves is kept as a durable result the person owns, in the shared store `lib/owned-results.ts` (table `owned_results`; the computer-job report-back work can use the same module). Each one records its owner, where it came from (`code_job` or `computer_job` plus the job id), the Brick that made it and the name it had, type, size, SHA-256 and access (`owner` only).

- Encrypted (AES-256-GCM) in Universe's own storage under `code-jobs/`, opened only by Orbit's route `/api/workbench/outputs/<id>` for the owner, as an attachment. The provider's copy is gone within a day and nothing depends on it.
- Kept until the owner deletes it. The job's record expiring (days kept), the Brick being deleted or the provider's copy expiring do not remove it. A job that is cancelled, times out or is lost is the exception: it keeps no files at all (see Cancel above), because it did not end with a result. A Brick that is gone only changes the name shown to "A deleted Brick".
- The most one person may keep is the Limit "Result files one person may keep". A file that would go over is not kept; the Brick is told "your kept files are full: delete some to make room". The check is one step with the insert: `keepResult(input & { limitBytes }, store?)` takes a per-owner advisory lock (`owned-results:<ownerId>`), adds up what the owner keeps and inserts in one transaction, so two files kept at once cannot both fit in room for one. It returns `{ status: 'kept', row }` or `{ status: 'over_limit', keptBytes, limitBytes }` (the stored file is removed); callers read `.row` and handle `over_limit`. The read from the workspace is bounded by the smaller of the job's remaining allowance and the owner's remaining room, and the check uses the bytes really received, not the listed size.
- `GET /api/workbench/outputs` pages with an opaque cursor (`next`, the time and id of the last result), so results made at the same moment are neither lost nor repeated. `removeResultsOf` removes the ids it chose, with their keys, so a result made while it runs keeps its row and file.
- Owner routes: `GET /api/workbench/outputs` (list), `DELETE /api/workbench/outputs/<id>` (the stored file goes first; if it cannot be removed the result stays listed), `POST /api/workbench/outputs/<id>/artifact` (see below).
- Nothing publishes a result by itself. Publishing is a separate action by the owner: it makes an Artifact "Just you" (markdown, svg or html files only, within the artifact size Limit) with the Brick and result as provenance; the kept file stays. Sharing then goes through the normal artifact sharing.
- Results whose owner account is gone are removed by the sweep.

## Not covered

- Only markdown, svg and html results can become Artifacts; Artifacts have no generic file kind.
- A deleted Brick's name is replaced at read time on the results list. An Artifact made from a result before its Brick was deleted keeps the Brick's name until the existing deleted-Brick flow is extended to artifacts.
- A crash between opening the provider session and saving its id leaves a tool-less session at the provider (the provider has no list endpoint to find it).
- One cell is limited by the provider to 180 seconds; that is not configurable.
- `enable_tool_execution` is not in the provider's docs but is accepted and read back.
