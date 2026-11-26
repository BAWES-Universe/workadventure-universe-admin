-- Post 0.5.0, 1B (the honest check before a take over). New columns with no table rewrite, safe to run twice.
-- The computer: `blocked` (a program the agent left behind is still running after the fence), `restarting`, `running` (the person took over anyway). NULL otherwise.
ALTER TABLE "brick_computers" ADD COLUMN IF NOT EXISTS "take_over_check" VARCHAR(10);

-- The job: how many restarts the person chose, when the restart of the open ask was done (cleared at the hand back), and the ask that was open then, so Brick asks again with the same words.
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "restarts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "restarted_at" TIMESTAMP(3);
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "restart_kind" VARCHAR(10);
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "restart_what" VARCHAR(150);
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "restart_where" VARCHAR(150);
