-- Visitors (#628): how many saved visits have no name and can never get one, as counts only.
-- Read-only: it runs in a READ ONLY transaction and ends with ROLLBACK. It prints one line of JSON.
--
--   psql "${DATABASE_URL%%\?*}" -X -q -At -v ON_ERROR_STOP=1 -f scripts/nameless-visits-check.sql
--
-- A visit is one of these ("deletable") only when ALL of this holds, and scripts/nameless-visits-backup.sql and
-- scripts/nameless-visits-delete.sql use exactly the same test:
--   - it has no account on it (user_id is empty), no name and no email;
--   - its id is a raw uuid or `unverified-` and 32 hex characters, nothing else;
--   - no other visit with the same id has a name, an email or an account (that person's history stays whole);
--   - the visit has no record in room_access_relinks (deleting it would delete that record too);
--   - the id is not an account's own id, and is not the `unverified-` id of an account's email or uuid: those visits
--     belong to that account and scripts/unverified-visits-relink.sql moves them onto it, they are never deleted.
-- Visits with a name, with an account, or with any other kind of id are never touched.
-- No ids, names, emails or IPs are printed.
BEGIN TRANSACTION READ ONLY;

WITH claims AS (
  SELECT 'unverified-' || substr(encode(sha256(convert_to(c.claim, 'UTF8')), 'hex'), 1, 32) AS visitor_id
  FROM users u CROSS JOIN LATERAL (VALUES (u.email), (u.uuid)) AS c(claim)
  WHERE c.claim IS NOT NULL
), nameless AS (
  SELECT a.id, a.user_uuid, a.accessed_at, a.is_authenticated,
    coalesce(a.user_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) AS raw_uuid,
    coalesce(a.user_uuid ~ '^unverified-[0-9a-f]{32}$', false) AS unverified,
    EXISTS (
      SELECT 1 FROM room_accesses b
      WHERE b.user_uuid = a.user_uuid AND b.id <> a.id
        AND (b.user_id IS NOT NULL OR nullif(btrim(coalesce(b.user_name, '')), '') IS NOT NULL OR nullif(btrim(coalesce(b.user_email, '')), '') IS NOT NULL)
    ) AS id_has_a_named_visit,
    EXISTS (SELECT 1 FROM users u WHERE u.uuid = a.user_uuid)
      OR EXISTS (SELECT 1 FROM claims c WHERE c.visitor_id = a.user_uuid) AS id_is_an_account,
    EXISTS (SELECT 1 FROM room_access_relinks r WHERE r.room_access_id = a.id) AS has_a_relink_record
  FROM room_accesses a
  WHERE a.user_id IS NULL
    AND nullif(btrim(coalesce(a.user_name, '')), '') IS NULL
    AND nullif(btrim(coalesce(a.user_email, '')), '') IS NULL
), sorted AS (
  SELECT *,
    CASE
      WHEN NOT (raw_uuid OR unverified) THEN 'other_id'
      WHEN id_is_an_account THEN 'belongs_to_an_account'
      WHEN id_has_a_named_visit THEN 'same_id_has_a_named_visit'
      WHEN has_a_relink_record THEN 'has_a_relink_record'
      WHEN unverified THEN 'delete_unverified'
      ELSE 'delete_raw_uuid'
    END AS kind
  FROM nameless
)
SELECT jsonb_build_object(
  'postgres', current_setting('server_version'),
  'checked_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'all_visits', (SELECT count(*) FROM room_accesses),
  'visits_without_a_name_or_account', (SELECT count(*) FROM sorted),
  'by_kind', (SELECT coalesce(jsonb_object_agg(kind, n), '{}') FROM (SELECT kind, count(*) AS n FROM sorted GROUP BY kind) AS k),
  'deletable_visits', (SELECT count(*) FROM sorted WHERE kind LIKE 'delete_%'),
  'deletable_ids', (SELECT count(DISTINCT user_uuid) FROM sorted WHERE kind LIKE 'delete_%'),
  'deletable_marked_signed_in', (SELECT count(*) FROM sorted WHERE kind LIKE 'delete_%' AND is_authenticated),
  'deletable_first_day', (SELECT to_char(min(accessed_at), 'YYYY-MM-DD') FROM sorted WHERE kind LIKE 'delete_%'),
  'deletable_last_day', (SELECT to_char(max(accessed_at), 'YYYY-MM-DD') FROM sorted WHERE kind LIKE 'delete_%'),
  'visits_kept_after_delete', (SELECT count(*) FROM room_accesses) - (SELECT count(*) FROM sorted WHERE kind LIKE 'delete_%'),
  'two_cards_one_person', jsonb_build_object(
    -- Provable: one id that sits on a visit with an account AND on a visit without one (the same device both ways).
    'guest_ids_also_on_an_account', (SELECT count(DISTINCT g.user_uuid) FROM room_accesses g JOIN room_accesses m ON m.user_uuid = g.user_uuid AND m.user_id IS NOT NULL WHERE g.user_id IS NULL),
    -- Not proof of anything: a typed guest name that is also an account's name. Only counted, never merged.
    'guest_ids_named_like_an_account', (SELECT count(DISTINCT g.user_uuid) FROM room_accesses g JOIN users u ON lower(u.name) = lower(g.user_name) AND NOT u.is_guest WHERE g.user_id IS NULL)
  )
);

ROLLBACK;
