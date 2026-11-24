-- The runner's run of a job (a bot-server restart makes a new run, which numbers its turns from 1 again): a fault row says which run its turn belongs to, and a
-- give-back decision which run its judged turns were numbered in, so two runs with the same turn numbers are never read as one. Nullable columns on two tables that
-- this release creates (no rows to backfill; a runner that names no run leaves them null and null matches null).
ALTER TABLE "computer_job_faults" ADD COLUMN "run" VARCHAR(40);
ALTER TABLE "computer_give_back_decisions" ADD COLUMN "judged_run" VARCHAR(40);
