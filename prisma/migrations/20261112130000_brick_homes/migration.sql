-- A Brick that lives in a room (game #2005). The Brick stays its owner's own Brick and keeps no room of its own: a home
-- is a separate row that says it also stands in a room. A Brick has one home at most (bot_id is the key). Deleting the
-- room, the Brick or the person who placed it deletes only this row. Nothing is written for anyone here.

-- CreateTable
CREATE TABLE "brick_homes" (
    "bot_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "placed_by_id" TEXT NOT NULL,
    "behavior_type" VARCHAR(20) NOT NULL DEFAULT 'idle',
    "behavior_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brick_homes_pkey" PRIMARY KEY ("bot_id")
);

-- CreateIndex
CREATE INDEX "brick_homes_room_id_idx" ON "brick_homes"("room_id");

-- AddForeignKey
ALTER TABLE "brick_homes" ADD CONSTRAINT "brick_homes_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_homes" ADD CONSTRAINT "brick_homes_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_homes" ADD CONSTRAINT "brick_homes_placed_by_id_fkey" FOREIGN KEY ("placed_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
