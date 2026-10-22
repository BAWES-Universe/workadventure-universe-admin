-- Visitors (#531): how many "unverified-..." visits there are and whose account each one points to, as counts only.
-- Read-only: it runs in a READ ONLY transaction and ends with ROLLBACK. It prints one line of JSON.
--
--   psql "${DATABASE_URL%%\?*}" -X -q -At -v ON_ERROR_STOP=1 -f scripts/unverified-visits-check.sql > unverified-visits.json
--
-- A visit from a signed-in player whose sign-in had run out is saved under 'unverified-' + the first 32 hex characters
-- of sha256(the id the game sent), which is the account's email (or its uuid when it has none). This works out the same
-- id for every account and counts the visits that point to exactly one signed-in account (one_account: exactly the visits
-- scripts/unverified-visits-relink.sql moves back), and those it leaves alone: pointing to no account, to more than one,
-- only to an account still marked as a guest, already under an account, or not quite in the format.
-- It checks itself: "complete" is true only when those groups add up to every visit in the unverified format.
-- No ids, names, emails, IPs or slugs: universes, worlds and rooms are numbers (1, 2, 3...).
BEGIN TRANSACTION READ ONLY;

WITH claims AS (
  SELECT u.id AS user_id, u.is_guest,
    'unverified-' || substr(encode(sha256(convert_to(c.claim, 'UTF8')), 'hex'), 1, 32) AS visitor_id
  FROM users u CROSS JOIN LATERAL (VALUES (u.email), (u.uuid)) AS c(claim)
  WHERE c.claim IS NOT NULL
), owners AS (
  SELECT visitor_id,
    count(DISTINCT user_id) FILTER (WHERE NOT is_guest) AS signed_in,
    count(DISTINCT user_id) FILTER (WHERE is_guest) AS guests,
    min(user_id) FILTER (WHERE NOT is_guest) AS user_id
  FROM claims GROUP BY visitor_id
), unverified AS (
  SELECT a.id, a.user_uuid, a.user_id AS saved_user_id, a.is_authenticated, a.user_name, a.accessed_at,
    a.universe_id, a.world_id, a.room_id,
    a.user_uuid ~ '^unverified-[0-9a-f]{32}$' AS exact,
    coalesce(o.signed_in, 0) AS signed_in, coalesce(o.guests, 0) AS guests, o.user_id AS owner_id
  FROM room_accesses a LEFT JOIN owners o ON o.visitor_id = a.user_uuid
  WHERE a.user_uuid LIKE 'unverified-%'
), sorted AS (
  SELECT *,
    CASE
      WHEN NOT exact THEN 'other_format'
      WHEN saved_user_id IS NOT NULL THEN 'already_has_an_account'
      WHEN signed_in = 1 AND guests = 0 THEN 'one_account'
      WHEN signed_in + guests > 1 THEN 'more_than_one_account'
      WHEN guests > 0 THEN 'guest_marked_account_only'
      ELSE 'no_account'
    END AS kind
  FROM unverified
), u AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM universes
), w AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM worlds
), r AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM rooms
), moved_people AS (
  SELECT DISTINCT owner_id FROM sorted WHERE kind = 'one_account'
)
SELECT jsonb_build_object(
  'postgres', current_setting('server_version'),
  'checked_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'all_visits', (SELECT count(*) FROM room_accesses),
  'unverified_visits', (SELECT count(*) FROM sorted),
  'by_kind', (SELECT coalesce(jsonb_object_agg(kind, n), '{}') FROM (SELECT kind, count(*) AS n FROM sorted GROUP BY kind) AS k),
  'unverified_ids', jsonb_build_object(
    'all', (SELECT count(DISTINCT user_uuid) FROM sorted),
    'one_account', (SELECT count(DISTINCT user_uuid) FROM sorted WHERE kind = 'one_account'),
    'more_than_one_account', (SELECT count(DISTINCT user_uuid) FROM sorted WHERE kind = 'more_than_one_account'),
    'no_account', (SELECT count(DISTINCT user_uuid) FROM sorted WHERE kind = 'no_account')
  ),
  'people_whose_visits_move', (SELECT count(*) FROM moved_people),
  'their_visits_before', (SELECT count(*) FROM room_accesses a JOIN moved_people p ON p.owner_id = a.user_id),
  'their_visits_after', (SELECT count(*) FROM room_accesses a JOIN moved_people p ON p.owner_id = a.user_id)
    + (SELECT count(*) FROM sorted WHERE kind = 'one_account'),
  'unverified_already_under_an_account', (SELECT count(*) FROM sorted WHERE saved_user_id IS NOT NULL),
  'unverified_marked_signed_in', (SELECT count(*) FROM sorted WHERE is_authenticated),
  'unverified_with_a_typed_name', (SELECT count(*) FROM sorted WHERE user_name IS NOT NULL),
  'unverified_first_day', (SELECT to_char(min(accessed_at), 'YYYY-MM-DD') FROM sorted),
  'unverified_last_day', (SELECT to_char(max(accessed_at), 'YYYY-MM-DD') FROM sorted),
  'other_guest_visits', (SELECT count(*) FROM room_accesses WHERE user_id IS NULL AND (user_uuid IS NULL OR user_uuid NOT LIKE 'unverified-%')),
  'places_touched', jsonb_build_object(
    'universes', (SELECT count(DISTINCT universe_id) FROM sorted WHERE kind = 'one_account'),
    'worlds', (SELECT count(DISTINCT world_id) FROM sorted WHERE kind = 'one_account'),
    'rooms', (SELECT count(DISTINCT room_id) FROM sorted WHERE kind = 'one_account')
  ),
  'rooms', (SELECT coalesce(jsonb_agg(jsonb_build_object('u', g.un, 'w', g.wn, 'r', g.rn, 'visits', g.visits, 'unverified', g.unverified, 'moving', g.moving) ORDER BY g.moving DESC, g.un, g.wn, g.rn), '[]')
    FROM (
      SELECT u.n AS un, w.n AS wn, r.n AS rn,
        (SELECT count(*) FROM room_accesses a WHERE a.room_id = s.room_id) AS visits,
        count(*) AS unverified, count(*) FILTER (WHERE s.kind = 'one_account') AS moving
      FROM sorted s JOIN u ON u.id = s.universe_id JOIN w ON w.id = s.world_id JOIN r ON r.id = s.room_id
      GROUP BY u.n, w.n, r.n, s.room_id
    ) AS g),
  'complete', (SELECT count(*) FILTER (WHERE kind IN ('one_account', 'more_than_one_account', 'no_account', 'guest_marked_account_only', 'already_has_an_account'))
    = count(*) FILTER (WHERE exact) FROM sorted)
    AND (SELECT count(*) FROM sorted) = (SELECT count(*) FROM room_accesses WHERE user_uuid LIKE 'unverified-%')
);

ROLLBACK;
