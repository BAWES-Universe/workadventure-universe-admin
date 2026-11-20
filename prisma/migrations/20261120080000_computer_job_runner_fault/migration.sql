-- A job that ended as ours on the computer runner's own word (the only ending a job's own words can steer) is marked, so the bound on give-backs counts
-- only those: a failure our own servers cause (a lapsed room, a start that broke) is always given back and uses none of a person's bound.
ALTER TABLE "computer_jobs" ADD COLUMN "runner_fault" BOOLEAN NOT NULL DEFAULT false;
