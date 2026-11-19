-- Report back: what reaches the person, and what stays theirs when it does not.
-- A report is "told" only when it was delivered; one that can never be delivered is marked so (and never offered again), and the files a computer made
-- stay with the person in Files either way. A job remembers the conversation it began in and what was on the machine before it began (so what it made
-- is what is new, not what happens to have been changed around the same time).
ALTER TABLE "computer_jobs" ADD COLUMN "start_files" JSONB,
ADD COLUMN "origin_kind" VARCHAR(10),
ADD COLUMN "origin_ref" VARCHAR(255),
ADD COLUMN "end_undeliverable_at" TIMESTAMP(3),
ADD COLUMN "end_undeliverable_why" VARCHAR(20);

ALTER TABLE "computer_job_files" ADD COLUMN "delivered_at" TIMESTAMP(3);
