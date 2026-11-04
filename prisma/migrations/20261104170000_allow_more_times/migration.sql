-- "Allow more of the same in this chat" times (game #1659, #1660): per bot, how long a remembered approval waits for the
-- asker's next message (30 min, 1 hour or 2 hours) and how long it lasts at most (4, 8 or 24 hours).
--
-- Nobody gains or loses anything: the defaults (1 hour, 8 hours) are what remembered approvals already last, and a caller
-- that passes its own times still wins.

-- AlterTable
ALTER TABLE "bots"
  ADD COLUMN "allow_more_idle_minutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "allow_more_max_minutes" INTEGER NOT NULL DEFAULT 480;

ALTER TABLE "bots" ADD CONSTRAINT "bots_allow_more_times" CHECK (
  "allow_more_idle_minutes" IN (30, 60, 120)
  AND "allow_more_max_minutes" IN (240, 480, 1440)
);
