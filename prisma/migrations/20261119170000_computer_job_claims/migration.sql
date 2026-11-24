-- Short claims on a job: one new key written at a time, and one turn started at a time
ALTER TABLE "computer_jobs" ADD COLUMN "prepare_claimed_at" TIMESTAMP(3);
ALTER TABLE "computer_jobs" ADD COLUMN "turn_claimed_at" TIMESTAMP(3);
