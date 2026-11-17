-- The Brick every signed-in person gets (game #1995). One row per account, written the first time that account's Brick
-- is made. The primary key is what makes it "once": a second device or a double tap finds the row and makes nothing.
-- The row stays when the Brick is deleted and its bot_id goes back to NULL, so a Brick deleted on purpose is remembered
-- and never made again. Nothing is written for anyone here: a person's row appears when they first open their chats.

-- CreateTable
CREATE TABLE "default_bricks" (
    "user_id" TEXT NOT NULL,
    "bot_id" TEXT,
    "made_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "default_bricks_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "default_bricks_bot_id_key" ON "default_bricks"("bot_id");

-- AddForeignKey
ALTER TABLE "default_bricks" ADD CONSTRAINT "default_bricks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "default_bricks" ADD CONSTRAINT "default_bricks_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
