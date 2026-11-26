-- A start whose answer the game never confirmed (GPT round 4, second note, R1): the game's own record of the key can be gone (a restart, an expired record), so Orbit keeps whether the game confirmed it HAS the answer.
-- A start that says it acks is made with this empty; the game fills it (an ack, or a look for the key that found the job). A new start under another key for the same person and Brick, while one is empty, makes no job.
-- Every job that exists now was made without this column: it counts as confirmed at its creation, so none of them ever blocks anything.
-- The default makes every job made by a version that does not know this column (the old game's starts, or the app before the deploy) confirmed at its creation; only a start that says it acks writes it empty on purpose.
ALTER TABLE "computer_jobs" ADD COLUMN "start_acked_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

UPDATE "computer_jobs" SET "start_acked_at" = "created_at";
