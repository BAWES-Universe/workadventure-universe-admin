-- A job's first turn is marked before it is sent: a start that finds the mark with no turn id and no conversation never opens a second turn beside it
ALTER TABLE "computer_jobs" ADD COLUMN "first_turn_sent_at" TIMESTAMP(3);
