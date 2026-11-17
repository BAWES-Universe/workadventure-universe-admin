-- Goals and tasks (game #2002): the bot server keeps how a run was to be reported together with where its message went, so a run handed out
-- again after a restart reports a goal that reached its outcome as reached, with its progress, and not as a plain "said".
-- Nothing is written for anyone by this migration.

-- AlterTable
ALTER TABLE "brick_item_runs" ADD COLUMN "delivered_report" JSONB;
