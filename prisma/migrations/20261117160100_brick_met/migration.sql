-- Keep an allowed direct message after a visit ends (game #2005, "People who met"; audit F05).
--
-- Until now a person who was not a Brick's owner could write to it only while it stood or walked in a place they could reach,
-- so the end of a visit silently ended the conversation. This table remembers that they met, so a direct message does not
-- depend on where the Brick is. Nothing is backfilled and no one is granted anything: a row is only written the next time a
-- Brick answers someone while it is somewhere other people can reach it.

-- CreateTable
CREATE TABLE "brick_met" (
    "bot_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "room_id" TEXT,
    "met_at" TIMESTAMP(3),
    "last_met_at" TIMESTAMP(3),
    "dm_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "brick_met_pkey" PRIMARY KEY ("bot_id","user_id")
);

-- CreateIndex
CREATE INDEX "brick_met_user_id_idx" ON "brick_met"("user_id");

-- CreateIndex
CREATE INDEX "brick_met_room_id_idx" ON "brick_met"("room_id");

-- AddForeignKey
ALTER TABLE "brick_met" ADD CONSTRAINT "brick_met_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_met" ADD CONSTRAINT "brick_met_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_met" ADD CONSTRAINT "brick_met_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
