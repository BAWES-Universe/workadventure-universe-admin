-- Limits on a person's voice key (#783): the values its owner changed for bots that use it (turnSeconds, replyCharacters,
-- replySeconds, listenMinutesPerDay). Empty for every row there is today: anything not saved follows the server's voice limits.

-- AlterTable
ALTER TABLE "voice_providers" ADD COLUMN "voice_limits" JSONB;
