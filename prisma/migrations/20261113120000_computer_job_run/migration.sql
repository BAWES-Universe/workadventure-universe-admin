-- Goals and tasks (game #2002): a computer job that a goal's or task's run started names that run, once for each Brick, so a run handed
-- out again finds the job it already started instead of starting a second one and taking a second room. Jobs started in chat have none.
-- Nothing is written for anyone by this migration.

-- AlterTable
ALTER TABLE "computer_jobs" ADD COLUMN "run_id" VARCHAR(36);

-- CreateIndex
CREATE UNIQUE INDEX "computer_jobs_bot_id_run_id_key" ON "computer_jobs"("bot_id", "run_id");
