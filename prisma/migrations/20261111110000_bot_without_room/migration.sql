-- A bot can exist without a room (game #1992): the base for a Brick, which is a bot that belongs to a person and lives in
-- that person's chats. Nothing about the bots that exist today changes: each keeps its room and gets no owner. "Created
-- by" on a room bot is not copied into the new column, because it only says who typed the bot in.

-- AlterTable: a bot's room becomes optional, and a bot can have an owner
ALTER TABLE "bots" ALTER COLUMN "room_id" DROP NOT NULL,
ADD COLUMN "owner_id" TEXT;

-- CreateIndex
CREATE INDEX "bots_owner_id_idx" ON "bots"("owner_id");

-- AddForeignKey: a Brick goes with its owner's account, as a room bot goes with its room
ALTER TABLE "bots" ADD CONSTRAINT "bots_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A bot lives in exactly one place: a room (a room bot) or its owner's chats (a Brick). Never neither, never both. Placing
-- a Brick in a room, and sending it back to its owner when that room is deleted, come with their own issue, which changes
-- this rule and the room delete together.
ALTER TABLE "bots" ADD CONSTRAINT "bots_room_or_owner" CHECK (("room_id" IS NULL) <> ("owner_id" IS NULL));
