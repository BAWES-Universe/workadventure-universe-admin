-- Brick tells the person how a computer job went, in their own chat with it (the report back).
--
-- Each ending is said once. `ended_told_at` is empty until it was said. Every job that is already over is marked as told now, so the first run
-- after this does not say old endings all at once. Each time a job waits for its person `handover_seq` goes up and `handover_untold` is true
-- until that wait was said. `end_note` and `end_waiting_for` keep the two things an ending message needs that the job loses when it is over.

ALTER TABLE "computer_jobs" ADD COLUMN "ended_told_at" TIMESTAMP(3);
ALTER TABLE "computer_jobs" ADD COLUMN "handover_seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "computer_jobs" ADD COLUMN "handover_untold" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "computer_jobs" ADD COLUMN "end_note" VARCHAR(200);
ALTER TABLE "computer_jobs" ADD COLUMN "end_waiting_for" VARCHAR(10);

UPDATE "computer_jobs" SET "ended_told_at" = COALESCE("ended_at", now()) WHERE "status" IN ('done', 'stopped', 'failed');

CREATE INDEX "computer_jobs_status_ended_told_at_idx" ON "computer_jobs"("status", "ended_told_at");
