-- Hide bot conversations (#435) migration check. Read-only: safe on production, before and after the migration.
--
--   psql "$DATABASE_URL" -At -F ' ' -f scripts/hide-bot-conversations-check.sql > after.txt    (after the release)
--
-- Nothing may change for any universe or bot on day one: no universe hides bot conversations, no bot has its own
-- choice, nobody has been asked to be forgotten, and the transcripts and what the bots remember are all still there.
-- The first three lines must say 0. Compare the last two with the same lines run before the release: they must match.
\echo universes that hide bot conversations
SELECT count(*)::text FROM "universes" WHERE "hide_bot_conversations";

\echo bots with their own choice
SELECT count(*)::text FROM "bots" WHERE "hide_conversations" IS NOT NULL;

\echo forget rows
SELECT count(*)::text FROM "bot_memory_forgets";

\echo saved transcripts
SELECT count(*)::text FROM "bots_conversations_recent";

\echo saved bot memories
SELECT count(*)::text FROM "bots_memory";
