-- Visitors (#628): delete the visits that pass the test in scripts/nameless-visits-check.sql, and only those. Run it only
-- after the backup file exists, passing the number of visits in it (lines minus the header):
--
--   psql "${DATABASE_URL%%\?*}" -X -q -At -v ON_ERROR_STOP=1 -v expected=<rows in the backup file> -f scripts/nameless-visits-delete.sql
--
-- A visit is deleted only if it has no account, name or email; its id is a raw uuid or `unverified-` and 32 hex
-- characters; no named visit has the same id; it has no record in room_access_relinks; and the id is not an account's. One transaction: if the number that pass
-- the test is not exactly `expected`, or the visits of anyone with a name or account would change in number, nothing is
-- deleted. It prints one line of JSON with the counts.
\if :{?expected}
\else
  \echo 'pass -v expected=<number of rows in the backup file>'
  \quit 1
\endif
BEGIN;

CREATE TEMP TABLE totals_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM room_accesses) AS visits,
  (SELECT count(*) FROM room_accesses WHERE user_id IS NOT NULL OR nullif(btrim(coalesce(user_name, '')), '') IS NOT NULL OR nullif(btrim(coalesce(user_email, '')), '') IS NOT NULL) AS named_or_account;

CREATE TEMP TABLE gone ON COMMIT DROP AS
WITH claims AS (
  SELECT 'unverified-' || substr(encode(sha256(convert_to(c.claim, 'UTF8')), 'hex'), 1, 32) AS visitor_id
  FROM users u CROSS JOIN LATERAL (VALUES (u.email), (u.uuid)) AS c(claim)
  WHERE c.claim IS NOT NULL
)
SELECT a.id FROM room_accesses a
WHERE a.user_id IS NULL
  AND nullif(btrim(coalesce(a.user_name, '')), '') IS NULL
  AND nullif(btrim(coalesce(a.user_email, '')), '') IS NULL
  AND (a.user_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR a.user_uuid ~ '^unverified-[0-9a-f]{32}$')
  AND NOT EXISTS (
    SELECT 1 FROM room_accesses b
    WHERE b.user_uuid = a.user_uuid AND b.id <> a.id
      AND (b.user_id IS NOT NULL OR nullif(btrim(coalesce(b.user_name, '')), '') IS NOT NULL OR nullif(btrim(coalesce(b.user_email, '')), '') IS NOT NULL)
  )
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.uuid = a.user_uuid)
  AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.visitor_id = a.user_uuid)
  AND NOT EXISTS (SELECT 1 FROM room_access_relinks r WHERE r.room_access_id = a.id);

-- Stops the whole thing, deleting nothing, when the backup and today's data disagree.
SELECT set_config('nameless.expected', :'expected', true) AS _ \gset
DO $$
BEGIN
  IF (SELECT count(*) FROM gone) <> current_setting('nameless.expected')::bigint THEN
    RAISE EXCEPTION 'nameless visits: % in the backup but % pass the test now; nothing deleted', current_setting('nameless.expected'), (SELECT count(*) FROM gone);
  END IF;
END $$;

DELETE FROM room_accesses a USING gone g WHERE a.id = g.id;

DO $$
BEGIN
  IF (SELECT count(*) FROM room_accesses WHERE user_id IS NOT NULL OR nullif(btrim(coalesce(user_name, '')), '') IS NOT NULL OR nullif(btrim(coalesce(user_email, '')), '') IS NOT NULL)
     <> (SELECT named_or_account FROM totals_before) THEN
    RAISE EXCEPTION 'nameless visits: a visit with a name or account would have changed; nothing deleted';
  END IF;
END $$;

SELECT jsonb_build_object(
  'expected', current_setting('nameless.expected')::bigint,
  'deleted', (SELECT count(*) FROM gone),
  'visits_before', (SELECT visits FROM totals_before),
  'visits_after', (SELECT count(*) FROM room_accesses),
  'named_or_account_visits_before', (SELECT named_or_account FROM totals_before),
  'named_or_account_visits_after', (SELECT count(*) FROM room_accesses WHERE user_id IS NOT NULL OR nullif(btrim(coalesce(user_name, '')), '') IS NOT NULL OR nullif(btrim(coalesce(user_email, '')), '') IS NOT NULL)
);

COMMIT;
