-- Visitors (#628): print every deletable visit (the test in scripts/nameless-visits-check.sql) as CSV, whole rows, so
-- scripts/nameless-visits-restore.sql can put them back. Read-only on the database. The CSV goes to the output: save it
-- to a file only you can read (it holds IP addresses):
--
--   (umask 077; psql "${DATABASE_URL%%\?*}" -X -q -At -v ON_ERROR_STOP=1 -f scripts/nameless-visits-backup.sql > nameless-visits-backup.csv)
--
-- Check the row count of the file (lines minus the header) against deletable_visits from the check script before deleting.
\copy (WITH claims AS (SELECT 'unverified-' || substr(encode(sha256(convert_to(c.claim, 'UTF8')), 'hex'), 1, 32) AS visitor_id FROM users u CROSS JOIN LATERAL (VALUES (u.email), (u.uuid)) AS c(claim) WHERE c.claim IS NOT NULL) SELECT a.* FROM room_accesses a WHERE a.user_id IS NULL AND nullif(btrim(coalesce(a.user_name, '')), '') IS NULL AND nullif(btrim(coalesce(a.user_email, '')), '') IS NULL AND (a.user_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR a.user_uuid ~ '^unverified-[0-9a-f]{32}$') AND NOT EXISTS (SELECT 1 FROM room_accesses b WHERE b.user_uuid = a.user_uuid AND b.id <> a.id AND (b.user_id IS NOT NULL OR nullif(btrim(coalesce(b.user_name, '')), '') IS NOT NULL OR nullif(btrim(coalesce(b.user_email, '')), '') IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.uuid = a.user_uuid) AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.visitor_id = a.user_uuid) ORDER BY a.accessed_at, a.id) TO STDOUT WITH (FORMAT csv, HEADER true)
