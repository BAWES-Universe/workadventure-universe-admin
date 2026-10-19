-- Reply limits are off unless the owner sets one (#1159, follow-up to #427).
--
-- The first version gave every bot a daily cap of 50. If a limit were ever switched on, that would limit every person
-- on every bot with nobody choosing it. Now the cap is empty ("No limit") until an owner types a number, so a bot
-- answers exactly as it does today. Nothing reads the number yet.
--
-- Bots that still say 50 are emptied: nobody could have chosen 50 on purpose (nothing in Orbit or the game set or
-- read it before this).

-- AlterTable
ALTER TABLE "bots" ALTER COLUMN "daily_reply_cap" DROP NOT NULL,
ALTER COLUMN "daily_reply_cap" DROP DEFAULT;

UPDATE "bots" SET "daily_reply_cap" = NULL WHERE "daily_reply_cap" = 50;
