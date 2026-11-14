-- The task in the person's own words, for the agent on the computer; cleared when the job ends
ALTER TABLE "computer_jobs" ADD COLUMN "brief" VARCHAR(4000);
