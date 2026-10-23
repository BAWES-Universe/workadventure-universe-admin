-- A model per bot and a model list per lend (#575). Both columns start empty, and every bot already on a person's key gets
-- that key's model, so nothing a bot replies with changes.

-- AlterTable
ALTER TABLE "bots" ADD COLUMN "ai_model" VARCHAR(255);

-- AlterTable
ALTER TABLE "ai_key_lends" ADD COLUMN "models" JSONB;

-- Backfill: a bot on a person's own key keeps replying with the model that key was added with
UPDATE "bots" AS b
SET "ai_model" = p."model"
FROM "bots_ai_providers" AS p
WHERE b."ai_provider_ref" = p."provider_id"
  AND p."owner_id" IS NOT NULL
  AND p."model" IS NOT NULL;
