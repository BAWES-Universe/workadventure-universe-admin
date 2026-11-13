-- Goals and tasks (game #2002): a watch, briefing or goal whose person has used up what goals and tasks may take of their Universe AI
-- usage waits, with its work saved, and carries on when it is back. These say since when, when Brick was last asked to say so, and whether it did. Nothing is
-- written for anyone by this migration.

-- AlterTable
ALTER TABLE "brick_items" ADD COLUMN "held_since" TIMESTAMP(3),
ADD COLUMN "held_told_at" TIMESTAMP(3),
ADD COLUMN "held_notice_at" TIMESTAMP(3);

-- The run of a goal or task a model call was made for, when the bot server says, so a run that has started using its room stops holding a place in it.
-- AlterTable
ALTER TABLE "bots_ai_usage" ADD COLUMN "brick_run_id" VARCHAR(36);

-- CreateIndex
CREATE INDEX "bots_ai_usage_brick_run_id_idx" ON "bots_ai_usage"("brick_run_id");
