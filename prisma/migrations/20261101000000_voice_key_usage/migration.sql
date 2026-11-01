-- Voice replies a person's voice key paid for (#749): one row per key, bot and month, so the AI keys page can say
-- "This month: N voice replies" for the key and for each bot on it. A new table; nothing that exists today is changed.

-- CreateTable
CREATE TABLE "voice_key_usage" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_key_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_key_usage_provider_id_bot_id_month_key" ON "voice_key_usage"("provider_id", "bot_id", "month");

-- CreateIndex
CREATE INDEX "voice_key_usage_provider_id_month_idx" ON "voice_key_usage"("provider_id", "month");

-- AddForeignKey
ALTER TABLE "voice_key_usage" ADD CONSTRAINT "voice_key_usage_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "voice_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_key_usage" ADD CONSTRAINT "voice_key_usage_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
