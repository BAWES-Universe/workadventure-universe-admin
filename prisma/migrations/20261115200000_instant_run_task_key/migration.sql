-- The task an Instant run belongs to, so rules about one task and the task's receipt read all of its runs
ALTER TABLE "instant_runs" ADD COLUMN "task_key" VARCHAR(255);
