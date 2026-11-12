-- Goals and tasks (game #2002): a watch, briefing or goal whose person has used up what goals and tasks may take of their Universe AI
-- usage waits, with its work saved, and carries on when it is back. These say since when, and whether Brick has said so. Nothing is
-- written for anyone by this migration.

-- AlterTable
ALTER TABLE "brick_items" ADD COLUMN "held_since" TIMESTAMP(3),
ADD COLUMN "held_told_at" TIMESTAMP(3);
