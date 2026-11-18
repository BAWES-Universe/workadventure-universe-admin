-- Computer jobs: a finished job that waits in line for its files to be handed over beats this every few seconds, so the gap between one hand-over letting go of
-- the machine and the next taking it is not mistaken for nobody waiting (the machine is not rested and the report is not told in that gap).
ALTER TABLE "computer_jobs" ADD COLUMN "hand_over_alive_at" TIMESTAMP(3);
