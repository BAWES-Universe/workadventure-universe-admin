-- #365: the user-outfits backfill (20261012100000) took each person's companion from their newest saved row that has one,
-- skipping rows where they chose "no companion". Someone who removed their pet in one world but still had one saved in
-- another got that older pet back, in every world. This clears it again where the data is clear.
--
-- Clear: a row with no companion and no Woka can only come from choosing "no companion" in that world. When such a row is
-- newer than every row with a pet, "no companion" was their last choice. A row with no companion but a Woka can also mean
-- they never chose a companion there, so it is left alone, and so is everyone who picked a companion since: every pick
-- since 20261012100000 also rewrites that world's row, which makes it the newest.
--
-- The people it would change are locked first: a companion save already running finishes before the update, and one that
-- starts now waits for it. The update is its own statement, so it sees every save finished by then, and never clears a
-- pet picked a moment ago. Both run in one transaction, so the lock holds until the update is done.
BEGIN;

SELECT "id" FROM "users"
WHERE "companion_texture_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "user_avatars" AS "none"
    WHERE "none"."user_id" = "users"."id"
      AND "none"."companion_texture_id" IS NULL
      AND cardinality("none"."texture_ids") = 0
      AND NOT EXISTS (
        SELECT 1 FROM "user_avatars" AS "pet"
        WHERE "pet"."user_id" = "users"."id"
          AND "pet"."companion_texture_id" IS NOT NULL
          AND "pet"."updated_at" >= "none"."updated_at"
      )
  )
FOR UPDATE;

UPDATE "users" SET "companion_texture_id" = NULL
WHERE "companion_texture_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "user_avatars" AS "none"
    WHERE "none"."user_id" = "users"."id"
      AND "none"."companion_texture_id" IS NULL
      AND cardinality("none"."texture_ids") = 0
      AND NOT EXISTS (
        SELECT 1 FROM "user_avatars" AS "pet"
        WHERE "pet"."user_id" = "users"."id"
          AND "pet"."companion_texture_id" IS NOT NULL
          AND "pet"."updated_at" >= "none"."updated_at"
      )
  );

COMMIT;
