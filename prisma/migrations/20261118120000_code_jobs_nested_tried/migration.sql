-- Code jobs: when the sweep last tried to read the provider's log of a session. A job whose read keeps failing goes behind the ones not tried yet,
-- so it never keeps the others out of the sweep's batch. Nothing to backfill (null sorts first).
ALTER TABLE "code_jobs" ADD COLUMN "nested_tried_at" TIMESTAMP(3);
