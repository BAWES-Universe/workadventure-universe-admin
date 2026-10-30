-- Voice settings (#740), the universe switch.
--
-- Nothing changes for anyone: no bot has voice yet. Every universe starts with "Allow voice bots here" on, so a universe
-- is never the reason a bot can't speak until someone turns it off.

-- AlterTable
ALTER TABLE "universes" ADD COLUMN     "allow_voice_bots" BOOLEAN NOT NULL DEFAULT true;
