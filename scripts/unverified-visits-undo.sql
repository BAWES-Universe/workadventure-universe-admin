-- Visitors (#531): put back every visit scripts/unverified-visits-relink.sql moved, exactly as it was before, from the
-- record it kept in room_access_relinks. Use it only if the move has to be taken back.
--
--   psql "${DATABASE_URL%%\?*}" -X -q -At -v ON_ERROR_STOP=1 -f scripts/unverified-visits-undo.sql
--
-- One transaction. Each record is marked undone, so running it again puts nothing back twice. It prints one line of JSON
-- with the counts. No visit is added or deleted.
BEGIN;

CREATE TEMP TABLE undo ON COMMIT DROP AS
SELECT id, room_access_id, old_user_uuid, old_user_id, old_user_name, old_user_email, old_is_guest
FROM room_access_relinks
WHERE undone_at IS NULL;

CREATE TEMP TABLE totals_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM room_accesses) AS visits,
  (SELECT count(*) FROM room_accesses WHERE user_uuid LIKE 'unverified-%') AS unverified;

UPDATE room_accesses a
SET user_uuid = u.old_user_uuid, user_id = u.old_user_id, user_name = u.old_user_name, user_email = u.old_user_email,
  is_guest = u.old_is_guest
FROM undo u
WHERE a.id = u.room_access_id;

UPDATE room_access_relinks r SET undone_at = CURRENT_TIMESTAMP FROM undo u WHERE r.id = u.id;

SELECT jsonb_build_object(
  'put_back', (SELECT count(*) FROM undo),
  'unverified_before', (SELECT unverified FROM totals_before),
  'unverified_after', (SELECT count(*) FROM room_accesses WHERE user_uuid LIKE 'unverified-%'),
  'visits_before', (SELECT visits FROM totals_before),
  'visits_after', (SELECT count(*) FROM room_accesses)
);

COMMIT;
