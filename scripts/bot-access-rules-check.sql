-- Per-bot rules (#427) migration check. Read-only: safe on production, before and after the migration.
--
--   psql "$DATABASE_URL" -At -F ' ' -f scripts/bot-access-rules-check.sql > after.txt    (after the release)
--
-- Nothing may change for any bot on day one: no bot is private, none has an owner line, none has a rule row, and
-- every bot has the default cap of 50. Every line below must say 0.
\echo bots that are private
SELECT count(*)::text FROM "bots" WHERE "private_bot";

\echo bots with an owner line
SELECT count(*)::text FROM "bots" WHERE "refusal_reply" IS NOT NULL;

\echo bots with a daily cap other than 50
SELECT count(*)::text FROM "bots" WHERE "daily_reply_cap" <> 50;

\echo rule rows
SELECT count(*)::text FROM "bot_access_rules";
