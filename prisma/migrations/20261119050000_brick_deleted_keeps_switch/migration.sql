-- A deleted Brick always keeps the switch Undo gives back (follows 20261111200000_brick_delete_undo, which stays as it was applied).
--
-- The first check let a Brick wait deleted with its end date and its switch off but with no saved switch (enabled_before_delete
-- NULL), which broke the rule that the three deletion fields stay together. Orbit never writes that (the delete sets all three in one
-- statement), so no real row is expected to be in it; a row that was is given the safe answer, "off", so Undo can never switch
-- on a Brick whose switch was not kept. Then the check is made again with the missing part.

UPDATE "bots" SET "enabled_before_delete" = false WHERE "deleted_at" IS NOT NULL AND "enabled_before_delete" IS NULL;

ALTER TABLE "bots" DROP CONSTRAINT "bots_deleted_brick";

ALTER TABLE "bots" ADD CONSTRAINT "bots_deleted_brick" CHECK (
    ("deleted_at" IS NULL AND "gone_at" IS NULL AND "enabled_before_delete" IS NULL)
    OR ("deleted_at" IS NOT NULL AND "gone_at" IS NOT NULL AND "enabled_before_delete" IS NOT NULL AND "room_id" IS NULL AND "enabled" = false)
);
