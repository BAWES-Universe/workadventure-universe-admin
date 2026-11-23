-- One live owner per computer job, work that is not ready to be run, and the stretch each charge belongs to (GPT's sixth answer, findings 3, 7 and 8).
-- Additive only: every column is nullable, so a server of the version before this runs beside it unchanged (it never reads them). One trigger (computer_jobs_hold_pause) guards a paused job against a server of the version before this.

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
-- Set when a second pause lands while one is still waiting for its browser to be put away (one command that pauses a writer and a looker): the browser is then never put away under either job's name,
-- it is emptied (CodeRabbit on #1025). Cleared with the pointer.
ALTER TABLE "brick_computers" ADD COLUMN "park_pending_wipe" BOOLEAN NOT NULL DEFAULT false;
-- Whether a pause really put a browser away (true), or found nothing to put away (false: the job has no browser of its own to wait for). Null: not known (the park has not answered yet, or it failed).
ALTER TABLE "computer_job_pauses" ADD COLUMN "sign_ins_kept" BOOLEAN;

-- Which stretch of its job a charge belongs to, written when the call was ADMITTED (finding 8): the job's number of pauses then, under the job's cutoff lock, which is
-- the lock a pause takes. Every ruling about a pause compares these numbers instead of two clocks. Null on every row of before this, and on room that is not a
-- computer call's: read as 0.
ALTER TABLE "meter_reservations" ADD COLUMN "job_stretch" INTEGER;
ALTER TABLE "credit_holds" ADD COLUMN "job_stretch" INTEGER;

-- A job the person (or their month, or a limit) PAUSED is `queued` with `queued_for = 'paused'`. A server of the version before this does not read `queued_for` when it picks a job from the line, so for the minutes of a
-- rolling deploy it could start a paused job, or write `queued_for = 'busy'` over the pause, and so override what the person set (CodeRabbit N14 on #1025, Opus's ruling 23 Nov: option A). This trigger makes that
-- impossible whichever version writes: the row is SKIPPED (the writer sees 0 rows, which every server already reads as a lost race), for
--   (a) a paused job that goes to `running` or `waiting` straight from the line, and
--   (b) a write that moves `queued_for` off `paused` while `paused_why` is still set and the job stays `queued` (the old "queue busy" write). Resume and the carry-on flip clear `paused_why` in the same UPDATE, so they pass.
-- Endings (done, stopped, failed) are never blocked: a cancel, a stop or a purge of a paused job goes through.
-- TO BE REMOVED in the release after 0.5.0, once no 0.4.x Orbit can run.
CREATE OR REPLACE FUNCTION "computer_jobs_hold_pause"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'queued' AND OLD."queued_for" = 'paused' AND NEW."status" IN ('running', 'waiting') THEN
    RETURN NULL;
  END IF;
  IF OLD."queued_for" = 'paused' AND NEW."queued_for" IS DISTINCT FROM 'paused' AND NEW."paused_why" IS NOT NULL AND NEW."status" = 'queued' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "computer_jobs_hold_pause" BEFORE UPDATE ON "computer_jobs" FOR EACH ROW WHEN (OLD."queued_for" = 'paused') EXECUTE FUNCTION "computer_jobs_hold_pause"();

-- No job starts on a Brick while a pause on it still has its browser to put away, whichever server writes the start (CodeRabbit on #1025): a server of the version before this does not read `park_pending_job_id`, so for the
-- minutes of a rolling deploy it could put a job on the browser that still holds the paused job's sign-ins. The start (queued -> running or waiting) is SKIPPED (the writer sees 0 rows, a lost race to every server), except for
-- the paused job's own resume. The pause itself (running -> queued) and every ending pass. TO BE REMOVED with computer_jobs_hold_pause in the release after 0.5.0.
CREATE OR REPLACE FUNCTION "computer_jobs_hold_park"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "brick_computers" b WHERE b."bot_id" = NEW."bot_id" AND b."park_pending_job_id" IS NOT NULL AND b."park_pending_job_id" <> NEW."id") THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "computer_jobs_hold_park" BEFORE UPDATE ON "computer_jobs" FOR EACH ROW WHEN (OLD."status" = 'queued' AND NEW."status" IN ('running', 'waiting')) EXECUTE FUNCTION "computer_jobs_hold_park"();
