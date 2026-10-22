-- Lending an AI key to a universe (#374, part 5): a new table; nothing existing is touched.

-- CreateTable
CREATE TABLE "ai_key_lends" (
    "id" TEXT NOT NULL,
    "provider_id" VARCHAR(50) NOT NULL,
    "universe_id" TEXT NOT NULL,
    "lent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_key_lends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_key_lends_provider_id_universe_id_key" ON "ai_key_lends"("provider_id", "universe_id");

-- CreateIndex
CREATE INDEX "ai_key_lends_universe_id_idx" ON "ai_key_lends"("universe_id");

-- AddForeignKey
ALTER TABLE "ai_key_lends" ADD CONSTRAINT "ai_key_lends_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "bots_ai_providers"("provider_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_key_lends" ADD CONSTRAINT "ai_key_lends_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
