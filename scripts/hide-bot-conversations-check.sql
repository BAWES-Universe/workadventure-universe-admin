-- Hide bot conversations (#435) migration check. Read-only: safe on production, before and after the migration.
--
--   psql "$DATABASE_URL" -At -F ' ' -f scripts/hide-bot-conversations-check.sql > after.txt    (after the release)
--
-- Nothing may change for any universe or bot on day one: no universe hides bot conversations, no bot has its own
-- choice, nobody has been asked to be forgotten, and the transcripts and what the bots remember are all still there.
-- With -At every label prints on its own line, then its count. The counts under the first three labels (universes that
-- hide, bots with their own choice, forget rows) must be 0. The counts under "saved transcripts" and "saved bot
-- memories" must match the same two counts from the run before the release. Before the migration the first three
-- queries fail (their columns and table do not exist yet): psql reports that and carries on to the last two.
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
