-- Seconds a bot listened for its name in a day (game #1859): one row per bot and UTC day, so the daily listening limit set in Orbit
-- (#740) can be applied. A new table; nothing that exists today is changed.

-- CreateTable
CREATE TABLE "voice_listen_uses" (
    "bot_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_listen_uses_pkey" PRIMARY KEY ("bot_id","day")
);

-- AddForeignKey
ALTER TABLE "voice_listen_uses" ADD CONSTRAINT "voice_listen_uses_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
