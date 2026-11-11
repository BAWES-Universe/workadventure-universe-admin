-- More Bricks, and deleting one with Undo (game #1996).

-- A Brick its owner deleted waits until gone_at, and Undo gives it back before then. While it waits it is off, so
-- nothing that respects a bot's switch runs it, and enabled_before_delete is where Undo leaves that switch. The check
-- holds the three together: only a Brick (no room) can wait deleted, a deleted Brick always has its end date, and it is
-- always off, so no save anywhere can switch a deleted Brick back on by accident.
--
-- hello is the first line of a Brick's chat, shown by the game while nothing has been written there. It is written once
-- when a Brick is made for a job, and stays NULL for every other bot: the game then shows its own fixed hello.

-- AlterTable
ALTER TABLE "bots"
    ADD COLUMN "deleted_at" TIMESTAMP(3),
    ADD COLUMN "gone_at" TIMESTAMP(3),
    ADD COLUMN "enabled_before_delete" BOOLEAN,
    ADD COLUMN "hello" VARCHAR(300);

ALTER TABLE "bots" ADD CONSTRAINT "bots_deleted_brick" CHECK (
    ("deleted_at" IS NULL AND "gone_at" IS NULL AND "enabled_before_delete" IS NULL)
    OR ("deleted_at" IS NOT NULL AND "gone_at" IS NOT NULL AND "room_id" IS NULL AND "enabled" = false)
);

-- CreateIndex
CREATE INDEX "bots_gone_at_idx" ON "bots"("gone_at");

-- A suggestion to make a Brick for a kind of job that keeps coming back. One row per person and topic: the primary key
-- is what makes it "at most once per topic", in every chat and on every device, whatever the person answered.

-- CreateTable
CREATE TABLE "brick_offers" (
    "user_id" TEXT NOT NULL,
    "topic" VARCHAR(60) NOT NULL,
    "answer" VARCHAR(10),
    "offered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMP(3),

    CONSTRAINT "brick_offers_pkey" PRIMARY KEY ("user_id","topic")
);

-- AddForeignKey
ALTER TABLE "brick_offers" ADD CONSTRAINT "brick_offers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
