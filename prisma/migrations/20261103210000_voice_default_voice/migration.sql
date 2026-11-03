-- The voice Universe AI speaks with when a bot's maker turns voice on without a key of their own (game #1668): set by a super
-- admin on the server's default speaking provider. Empty for every row there is today: the bot page then uses the first voice
-- the provider lists.

-- AlterTable
ALTER TABLE "voice_providers" ADD COLUMN "default_voice_id" VARCHAR(255),
ADD COLUMN "default_voice_name" VARCHAR(255);
