-- When the outfit itself was last picked, so a companion change doesn't make an older outfit look newest.
ALTER TABLE "user_avatars" ADD COLUMN     "outfit_updated_at" TIMESTAMP(3);
UPDATE "user_avatars" SET "outfit_updated_at" = "updated_at" WHERE cardinality("texture_ids") > 0;
