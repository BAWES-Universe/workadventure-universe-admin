-- Goals and tasks (game #2002): a goal that is not sure it reached its outcome, or whose date has passed, asks the person once: close it,
-- keep going, or change it. These keep the one open question, the run asked to ask it and whether it did, and the questions the person
-- answered "keep going" to, so one need is one message. Nothing is written for anyone by this migration.

-- AlterTable
ALTER TABLE "brick_items" ADD COLUMN "ask_kind" VARCHAR(12),
ADD COLUMN "ask_run_id" VARCHAR(36),
ADD COLUMN "ask_told_at" TIMESTAMP(3),
ADD COLUMN "ask_kept" VARCHAR(40);
