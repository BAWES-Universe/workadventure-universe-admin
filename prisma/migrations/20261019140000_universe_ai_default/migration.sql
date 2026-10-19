-- Universe AI (#374, part 3): one server provider is the Default that bots on "Universe AI" run on.
--
-- The new column starts false everywhere. The only existing row touched is the first enabled server provider by name,
-- the one a new bot was always given, so Universe AI answers on exactly what a new bot got before. No bot, no provider
-- setting and no usage row is changed; bots already pinned to a provider keep it.

-- AlterTable
ALTER TABLE "bots_ai_providers" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

-- Mark the first enabled server provider (no owner) by name as the Default
UPDATE "bots_ai_providers" SET "is_default" = true
WHERE "provider_id" = (
  SELECT "provider_id" FROM "bots_ai_providers"
  WHERE "owner_id" IS NULL AND "enabled" = true
  ORDER BY "name" ASC
  LIMIT 1
);
