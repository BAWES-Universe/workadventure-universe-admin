-- Visitors (#531): a record of every visit scripts/unverified-visits-relink.sql moves back onto an account, with what the
-- visit held before, so scripts/unverified-visits-undo.sql can put each one back exactly. Nothing reads it in the app.
-- It starts empty: this migration changes no visit.

-- CreateTable
CREATE TABLE "room_access_relinks" (
    "id" TEXT NOT NULL,
    "room_access_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "old_user_uuid" TEXT,
    "old_user_id" TEXT,
    "old_user_name" TEXT,
    "old_user_email" TEXT,
    "old_is_guest" BOOLEAN NOT NULL,
    "relinked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMP(3),

    CONSTRAINT "room_access_relinks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_access_relinks_room_access_id_idx" ON "room_access_relinks"("room_access_id");

-- AddForeignKey
ALTER TABLE "room_access_relinks" ADD CONSTRAINT "room_access_relinks_room_access_id_fkey" FOREIGN KEY ("room_access_id") REFERENCES "room_accesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
