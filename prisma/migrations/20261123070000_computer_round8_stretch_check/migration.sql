-- Round 8, B2: nothing is billable before readiness. `stretch_started` stays NULL while a job's browser is being brought back; the database refuses the two together.
-- A row that had both (a start of an earlier build of this release) keeps its earlier stretches in `seconds_run` and starts its stretch again at readiness. Safe to run twice.
UPDATE "computer_jobs" SET "stretch_started" = NULL WHERE "prep_state" IS NOT NULL AND "stretch_started" IS NOT NULL;
ALTER TABLE "computer_jobs" DROP CONSTRAINT IF EXISTS "computer_jobs_prep_unbilled";
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_prep_unbilled" CHECK ("prep_state" IS NULL OR "stretch_started" IS NULL);
