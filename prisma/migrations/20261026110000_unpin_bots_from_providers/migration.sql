-- The provider pin is gone from the bot page (game #1446): a bot runs on Universe AI, which follows the Default provider,
-- or on a lent key. A bot still pinned to one of the server's own providers moves to Universe AI, and its model is cleared
-- (a model is only read for a personal key).
--
-- Only bots whose ref is a server provider (a provider with no owner) change. Bots already on Universe AI, on a personal
-- key, with no ref, or with a ref that no longer names anything are left exactly as they are. No provider, key, lend or
-- usage row is touched. A bot pinned to the provider that is the Default answers on the same provider as before.
UPDATE "bots"
SET "ai_provider_ref" = 'universe-ai', "ai_model" = NULL, "updated_at" = NOW()
WHERE "ai_provider_ref" IN (SELECT "provider_id" FROM "bots_ai_providers" WHERE "owner_id" IS NULL);
