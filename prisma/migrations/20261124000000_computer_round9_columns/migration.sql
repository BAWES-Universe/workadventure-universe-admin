-- Round 8, A2 (CodeRabbit on #1025, I7): the moment a REOPENED key supersedes from, kept on the attempt. Every delivery of the key then decides from the same stored boundary under the person's lock, instead of from whether
-- it happened to be the request that reopened the key. NULL = the key was never reopened (the attempt's own creation time is the boundary). A new column with no default: existing rows are unchanged, and it is safe to run twice.
ALTER TABLE "computer_start_attempts" ADD COLUMN IF NOT EXISTS "supersede_since" TIMESTAMP(3);

-- Round 8 (CodeRabbit on #1025, O46): when a job's start last reached its DECISION (it ran, went back in line, was refused, or failed), written by the start itself and reset when the job is paused or resumed. A copy of a Resume reads
-- a job still in line with no decision on record as one whose start has not decided yet. It is separate from `last_tried_at`, which the queue sweep sets BEFORE it calls the start (a sweep that selected the job decided nothing).
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "start_decided_at" TIMESTAMP(3);
