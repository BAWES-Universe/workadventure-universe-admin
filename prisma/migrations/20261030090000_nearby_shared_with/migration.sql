-- Who an item kept from a nearby chat was shared with (game #1615): the sender's chat account and the chat accounts of
-- the others there, so a person's profile lists what you and they shared nearby. Items kept before have neither.

-- AlterTable
ALTER TABLE "nearby_shared_items" ADD COLUMN "sender_chat_id" VARCHAR(255),
ADD COLUMN "with_chat_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "nearby_shared_items_user_id_sender_chat_id_sent_at_idx" ON "nearby_shared_items"("user_id", "sender_chat_id", "sent_at");

-- CreateIndex
CREATE INDEX "nearby_shared_items_with_chat_ids_idx" ON "nearby_shared_items" USING GIN ("with_chat_ids");
