-- Visitors (#628): put back the visits scripts/nameless-visits-delete.sql deleted, whole rows, from the backup CSV, which
-- it reads from the input. Use it only if the delete has to be taken back:
--
--   psql "${DATABASE_URL%%\?*}" -X -q -At -v ON_ERROR_STOP=1 -f scripts/nameless-visits-restore.sql < nameless-visits-backup.csv
--
-- One transaction. A visit that is already there is left as it is (so running it twice adds nothing twice), and a visit
-- whose room, world or universe no longer exists stops the restore with an error and restores nothing. It prints one
-- line of JSON with the counts.
BEGIN;

CREATE TEMP TABLE backup_rows (LIKE room_accesses) ON COMMIT DROP;
\copy backup_rows FROM pstdin WITH (FORMAT csv, HEADER true)

CREATE TEMP TABLE totals_before ON COMMIT DROP AS SELECT count(*) AS visits FROM room_accesses;

INSERT INTO room_accesses SELECT * FROM backup_rows ON CONFLICT (id) DO NOTHING;

SELECT jsonb_build_object(
  'in_file', (SELECT count(*) FROM backup_rows),
  'put_back', (SELECT count(*) FROM room_accesses) - (SELECT visits FROM totals_before),
  'visits_before', (SELECT visits FROM totals_before),
  'visits_after', (SELECT count(*) FROM room_accesses)
);

COMMIT;
