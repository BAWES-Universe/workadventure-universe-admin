-- Spoken replies counted against a person's Universe AI window (game #1669): one row per reply, keyed by its turn so
-- asking again for the same reply never counts it twice. A new table; nothing that exists today is changed.

-- CreateTable
CREATE TABLE "voice_reply_uses" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "turn_id" VARCHAR(255) NOT NULL,
    "person_key" VARCHAR(320) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_reply_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_reply_uses_bot_id_turn_id_key" ON "voice_reply_uses"("bot_id", "turn_id");

-- CreateIndex
CREATE INDEX "voice_reply_uses_person_key_created_at_idx" ON "voice_reply_uses"("person_key", "created_at");

-- AddForeignKey
ALTER TABLE "voice_reply_uses" ADD CONSTRAINT "voice_reply_uses_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
