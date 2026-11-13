-- Bringing a Brick along (game #2005).
--
-- Visiting Bricks is one switch per universe. Every universe that exists today starts with it OFF (the column is added
-- with the default "false", so each existing row gets that), and then the default for a universe made from now on is ON.
-- Nothing changes for anyone: no Brick visits anywhere until its owner brings it along somewhere that takes visits.

-- AlterTable
ALTER TABLE "universes" ADD COLUMN "allow_visiting_bricks" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "universes" ALTER COLUMN "allow_visiting_bricks" SET DEFAULT true;

-- CreateTable
CREATE TABLE "brick_visits" (
    "user_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "room_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brick_visits_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brick_visits_bot_id_key" ON "brick_visits"("bot_id");

-- CreateIndex
CREATE INDEX "brick_visits_room_id_seen_at_idx" ON "brick_visits"("room_id", "seen_at");

-- AddForeignKey
ALTER TABLE "brick_visits" ADD CONSTRAINT "brick_visits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_visits" ADD CONSTRAINT "brick_visits_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_visits" ADD CONSTRAINT "brick_visits_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
