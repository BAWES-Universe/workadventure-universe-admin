-- What a person asked a bot to forget, one thing at a time (game #2003). Only the key of what was said is kept (a hash),
-- never the words. A thing with a key here is taken out of every memory save and read for that person and bot, so it
-- stays gone however it comes back: a copy the bot server still holds, a restored row, older history. Nothing is written
-- until someone presses Forget.

-- CreateTable
CREATE TABLE "bot_memory_item_forgets" (
    "id" TEXT NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "user_uuid" VARCHAR(255) NOT NULL,
    "item_key" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dropped_at" TIMESTAMP(3),

    CONSTRAINT "bot_memory_item_forgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_memory_item_forgets_bot_id_user_uuid_item_key_key" ON "bot_memory_item_forgets"("bot_id", "user_uuid", "item_key");

-- CreateIndex
CREATE INDEX "bot_memory_item_forgets_bot_id_dropped_at_idx" ON "bot_memory_item_forgets"("bot_id", "dropped_at");
