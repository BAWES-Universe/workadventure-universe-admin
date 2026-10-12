-- A person wears one Woka everywhere: the last one they picked. user_outfits holds what they have worn (the newest is
-- the one they wear now, the rest is their Recent list) and users.companion_texture_id the companion they wear now.
-- user_avatars stays as it is (guests and bots still read it).
CREATE TABLE "user_outfits" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "texture_ids" TEXT[],
    "outfit_key" TEXT NOT NULL,
    "first_worn_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_worn_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_outfits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_outfits_user_id_outfit_key_key" ON "user_outfits"("user_id", "outfit_key");
CREATE INDEX "user_outfits_user_id_last_worn_at_idx" ON "user_outfits"("user_id", "last_worn_at");
ALTER TABLE "user_outfits" ADD CONSTRAINT "user_outfits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "users" ADD COLUMN "companion_texture_id" TEXT;

-- Backfill: one row per person and distinct outfit they saved in any world, first/last worn from when it was picked.
-- The newest one becomes the Woka they wear now.
INSERT INTO "user_outfits" ("id", "user_id", "texture_ids", "outfit_key", "first_worn_at", "last_worn_at")
SELECT
    gen_random_uuid()::text,
    "user_id",
    "texture_ids",
    array_to_string("texture_ids", '|'),
    MIN(COALESCE("outfit_updated_at", "updated_at")),
    MAX(COALESCE("outfit_updated_at", "updated_at"))
FROM "user_avatars"
WHERE cardinality("texture_ids") > 0
GROUP BY "user_id", "texture_ids";

-- The companion they wear now: the one on their most recently updated saved row that has one.
UPDATE "users" SET "companion_texture_id" = (
    SELECT "companion_texture_id"
    FROM "user_avatars"
    WHERE "user_avatars"."user_id" = "users"."id" AND "user_avatars"."companion_texture_id" IS NOT NULL
    ORDER BY "user_avatars"."updated_at" DESC
    LIMIT 1
);
