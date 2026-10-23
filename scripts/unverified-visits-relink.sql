-- Visitors (#531): move the "unverified-..." visits that belong to exactly one signed-in account back onto that account,
-- so Visitors shows one card per person again. Run the read-only scripts/unverified-visits-check.sql first.
--
--   psql "${DATABASE_URL%%\?*}" -X -q -At -v ON_ERROR_STOP=1 -f scripts/unverified-visits-relink.sql
--
-- A visit from a signed-in player whose sign-in had run out was saved under 'unverified-' + the first 32 hex characters
-- of sha256(the id the game sent): the account's email, or its uuid when it has none (Orbit #421). Only a visit whose id
-- has exactly that form, has no account on it, and works out to exactly one account not marked as a guest is moved.
-- Ids that match no account, more than one, or only a guest-marked one are left as they are.
--
-- Each moved visit gets the account's id, uuid, name and email, and is no longer counted as a guest, as visits were
-- saved before #421. It stays "not signed in" (is_authenticated false), so Visitors lists it as Guest inside the card.
-- No visit is added or deleted, so every room, world and universe keeps its visit total.
--
-- Every move is written to room_access_relinks with what the visit held before; scripts/unverified-visits-undo.sql puts
-- them back. It all happens in one transaction: it either moves every visit it should or none. Running it again moves
-- nothing more (a moved visit no longer has an unverified id). It prints one line of JSON with the counts.
BEGIN;

CREATE TEMP TABLE relink ON COMMIT DROP AS
WITH claims AS (
  SELECT u.id AS user_id, u.is_guest,
    'unverified-' || substr(encode(sha256(convert_to(c.claim, 'UTF8')), 'hex'), 1, 32) AS visitor_id
  FROM users u CROSS JOIN LATERAL (VALUES (u.email), (u.uuid)) AS c(claim)
  WHERE c.claim IS NOT NULL
), owners AS (
  SELECT visitor_id, min(user_id) AS user_id
  FROM claims
  GROUP BY visitor_id
  HAVING count(DISTINCT user_id) FILTER (WHERE NOT is_guest) = 1 AND count(DISTINCT user_id) FILTER (WHERE is_guest) = 0
)
SELECT a.id AS room_access_id, o.user_id
FROM room_accesses a JOIN owners o ON o.visitor_id = a.user_uuid
WHERE a.user_uuid ~ '^unverified-[0-9a-f]{32}$' AND a.user_id IS NULL;

CREATE TEMP TABLE totals_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM room_accesses) AS visits,
  (SELECT count(*) FROM room_accesses WHERE user_uuid LIKE 'unverified-%') AS unverified;

INSERT INTO room_access_relinks (id, room_access_id, user_id, old_user_uuid, old_user_id, old_user_name, old_user_email, old_is_guest)
SELECT gen_random_uuid()::text, a.id, r.user_id, a.user_uuid, a.user_id, a.user_name, a.user_email, a.is_guest
FROM relink r JOIN room_accesses a ON a.id = r.room_access_id;

UPDATE room_accesses a
SET user_id = u.id, user_uuid = u.uuid, user_name = coalesce(u.name, a.user_name), user_email = u.email, is_guest = false
FROM relink r JOIN users u ON u.id = r.user_id
WHERE a.id = r.room_access_id;

SELECT jsonb_build_object(
  'moved', (SELECT count(*) FROM relink),
  'people', (SELECT count(DISTINCT user_id) FROM relink),
  'unverified_before', (SELECT unverified FROM totals_before),
  'unverified_left', (SELECT count(*) FROM room_accesses WHERE user_uuid LIKE 'unverified-%'),
  'visits_before', (SELECT visits FROM totals_before),
  'visits_after', (SELECT count(*) FROM room_accesses),
  'logged', (SELECT count(*) FROM room_access_relinks r JOIN relink m ON m.room_access_id = r.room_access_id WHERE r.undone_at IS NULL)
);

COMMIT;
