-- Repairs a database that recorded an EARLIER body of 20261123030000_computer_owner_lease_and_stretch (a dev database that ran the migration before its columns and triggers were final: Prisma skips a name it has
-- already recorded, so the later body never ran there), and puts the park trigger in its final form for every database (CodeRabbit on #1025, A15 and D12). Every statement is idempotent: on a database that has the final
-- schema (any fresh one) the columns exist and the two functions and triggers are replaced by identical or newer ones, so nothing else changes.

-- Columns the generated client reads: without them any read of the Brick's computer or of a pause fails
ALTER TABLE "brick_computers" ADD COLUMN IF NOT EXISTS "park_pending_wipe" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "computer_job_pauses" ADD COLUMN IF NOT EXISTS "sign_ins_kept" BOOLEAN;

-- A paused job is not started, and its pause is not overwritten, whichever version of Orbit writes (the same definition as the migration above). TO BE REMOVED in the release after 0.5.0 with computer_jobs_hold_park.
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

DROP TRIGGER IF EXISTS "computer_jobs_hold_pause" ON "computer_jobs";
CREATE TRIGGER "computer_jobs_hold_pause" BEFORE UPDATE ON "computer_jobs" FOR EACH ROW WHEN (OLD."queued_for" = 'paused') EXECUTE FUNCTION "computer_jobs_hold_pause"();

-- No job starts on a Brick while a pause on it still has its browser to put away. The Brick's row is locked by `bot_id` BEFORE the pointer is read: a pause that has written the pointer and not committed holds that row, so
-- the start waits for it to commit or roll back, and the read that follows (a new statement) sees the committed pointer. A plain read would see the old, empty pointer and let the job start on the browser that still holds the
-- paused job's sign-ins. The paused job's own resume still passes (its id is the pointer's). The pause itself (running -> queued) and every ending pass. TO BE REMOVED with computer_jobs_hold_pause in the release after 0.5.0.
CREATE OR REPLACE FUNCTION "computer_jobs_hold_park"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "brick_computers" b WHERE b."bot_id" = NEW."bot_id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM "brick_computers" b WHERE b."bot_id" = NEW."bot_id" AND b."park_pending_job_id" IS NOT NULL AND b."park_pending_job_id" <> NEW."id") THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "computer_jobs_hold_park" ON "computer_jobs";
CREATE TRIGGER "computer_jobs_hold_park" BEFORE UPDATE ON "computer_jobs" FOR EACH ROW WHEN (OLD."status" = 'queued' AND NEW."status" IN ('running', 'waiting')) EXECUTE FUNCTION "computer_jobs_hold_park"();
