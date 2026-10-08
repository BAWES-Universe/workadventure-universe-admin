-- DropForeignKey
ALTER TABLE "bans" DROP CONSTRAINT "bans_world_id_fkey";

-- AlterTable
ALTER TABLE "bans" ADD COLUMN     "appeal_decided_at" TIMESTAMP(3),
ADD COLUMN     "appeal_decided_by" TEXT,
ADD COLUMN     "appeal_decision" TEXT,
ADD COLUMN     "appeal_text" TEXT,
ADD COLUMN     "appealed_at" TIMESTAMP(3),
ADD COLUMN     "lifted_at" TIMESTAMP(3),
ADD COLUMN     "lifted_by" TEXT;

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "world_id" TEXT NOT NULL,
    "room_id" TEXT,
    "reported_user_id" TEXT,
    "reported_uuid" TEXT NOT NULL,
    "reporter_user_id" TEXT,
    "reporter_uuid" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "handled_by" TEXT,
    "handled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_world_id_status_idx" ON "reports"("world_id", "status");

-- CreateIndex
CREATE INDEX "reports_reported_user_id_idx" ON "reports"("reported_user_id");

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_lifted_by_fkey" FOREIGN KEY ("lifted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_appeal_decided_by_fkey" FOREIGN KEY ("appeal_decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_user_id_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_fkey" FOREIGN KEY ("handled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A ban from a world now covers that world only. Bans made in the game used to carry the world's universe too,
-- which the entry checks read as a ban from the whole universe.
UPDATE "bans" SET "universe_id" = NULL WHERE "world_id" IS NOT NULL;

-- A world ban whose world was deleted kept only its universe and so blocked the whole universe; it no longer applies.
UPDATE "bans" SET "is_active" = false WHERE "world_id" IS NULL AND "universe_id" IS NOT NULL AND "is_active" = true;
