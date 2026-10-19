-- Personal AI keys (#374, part 7): is a key Working or Down, and what the bot does while it is down.
--
-- Every column is new. Server providers never use them (down_since stays NULL), so nothing existing changes.

-- AlterTable
ALTER TABLE "bots_ai_providers" ADD COLUMN "down_since" TIMESTAMP(3),
ADD COLUMN "down_reason" VARCHAR(20),
ADD COLUMN "failed_replies" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "health_checked_at" TIMESTAMP(3),
ADD COLUMN "if_down" VARCHAR(20) NOT NULL DEFAULT 'universe-ai';
