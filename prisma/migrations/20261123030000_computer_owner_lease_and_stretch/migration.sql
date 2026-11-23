-- One live owner per computer job, work that is not ready to be run, and the stretch each charge belongs to (GPT's sixth answer, findings 3, 7 and 8).
-- Additive only: every column is nullable, so a server of the version before this runs beside it unchanged (it never reads them).

-- How long the worker that owns a job holds it without beating: while this is in the future, no other worker may claim the job, however fresh the epoch it names
-- (finding 3). The owner renews it (`beat`, and every renewal or admission of its own) and lets it go on a graceful stop (`release`).
ALTER TABLE "computer_jobs" ADD COLUMN "owner_lease_until" TIMESTAMP(3);

-- A job that is getting ready and may not be worked on yet (finding 7): `restoring` while its browser is brought back after a pause, `recover` when that could not be
-- settled. Such a job is not offered to a runner, cannot be claimed, and authorizes no model call. Null is the usual: ready.
ALTER TABLE "computer_jobs" ADD COLUMN "prep_state" VARCHAR(10);
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_prep_state_check" CHECK ("prep_state" IS NULL OR "prep_state" IN ('restoring', 'recover')) NOT VALID;

-- The job whose pause is committed and whose browser is not put away yet (finding 7): while it is set, no other job starts on that machine, so a job never gets
-- another job's sign-ins. The park clears it, and the sweep wipes and clears it for a machine that cannot be reached.
ALTER TABLE "brick_computers" ADD COLUMN "park_pending_job_id" VARCHAR(40);

-- Which stretch of its job a charge belongs to, written when the call was ADMITTED (finding 8): the job's number of pauses then, under the job's cutoff lock, which is
-- the lock a pause takes. Every ruling about a pause compares these numbers instead of two clocks. Null on every row of before this, and on room that is not a
-- computer call's: read as 0.
ALTER TABLE "meter_reservations" ADD COLUMN "job_stretch" INTEGER;
ALTER TABLE "credit_holds" ADD COLUMN "job_stretch" INTEGER;
