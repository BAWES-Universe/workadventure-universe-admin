-- What was shared in nearby chats, kept for each signed-in person who was there (game #1424). New table, nothing
-- existing changes.

-- CreateTable
CREATE TABLE "nearby_shared_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "item_key" VARCHAR(300) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "link" VARCHAR(2000),
    "file_id" VARCHAR(200),
    "mime_type" VARCHAR(150),
    "size" INTEGER,
    "is_video" BOOLEAN NOT NULL DEFAULT false,
    "sender_name" VARCHAR(100) NOT NULL,
    "mine" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nearby_shared_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nearby_shared_items_user_id_item_key_key" ON "nearby_shared_items"("user_id", "item_key");

-- CreateIndex
CREATE INDEX "nearby_shared_items_user_id_sent_at_idx" ON "nearby_shared_items"("user_id", "sent_at");

-- AddForeignKey
ALTER TABLE "nearby_shared_items" ADD CONSTRAINT "nearby_shared_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
