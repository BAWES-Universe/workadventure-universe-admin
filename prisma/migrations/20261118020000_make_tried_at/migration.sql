-- When a machine was first asked for (before the provider is called, never cleared): a computer record without one never had a machine made, so a purge has nothing to look for at the provider.
ALTER TABLE "brick_computers" ADD COLUMN "make_tried_at" TIMESTAMP(3);

-- Records that exist already and have no machine written down may have had one made and lost: they stay looked for
UPDATE "brick_computers" SET "make_tried_at" = CURRENT_TIMESTAMP WHERE "provider_ref" IS NULL AND "machine" = 'none';
