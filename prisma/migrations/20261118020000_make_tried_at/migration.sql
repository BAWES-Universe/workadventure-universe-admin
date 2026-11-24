-- When a machine was first asked for (before the provider is called, never cleared): a computer record without one never had a machine made, so a purge has nothing to look for at the provider.
ALTER TABLE "brick_computers" ADD COLUMN "make_tried_at" TIMESTAMP(3);

-- Records that exist already and have no machine written down may have had one made and lost (also one caught while it was being made, `waking`, that is put back to `none` later): they stay looked for.
-- Only a computer that is packed away (`cold`) is left out: it has no machine to look for.
UPDATE "brick_computers" SET "make_tried_at" = CURRENT_TIMESTAMP WHERE "provider_ref" IS NULL AND "machine" <> 'cold';
