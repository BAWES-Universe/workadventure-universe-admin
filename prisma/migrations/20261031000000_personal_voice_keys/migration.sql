-- Personal voice keys (#749): a person's own voice key, lent to the universes where they manage bots.
--
-- Every voice provider there is today stays the server's own (owner_id empty). A key someone adds is a row with an owner; it
-- is never a default and is deleted with its owner. A lend is one key in one universe, with the models bots there may use
-- (empty = all of them). Nothing that exists today is changed.

-- AlterTable
ALTER TABLE "voice_providers" ADD COLUMN "owner_id" TEXT;

-- CreateIndex
CREATE INDEX "voice_providers_owner_id_idx" ON "voice_providers"("owner_id");

-- AddForeignKey
ALTER TABLE "voice_providers" ADD CONSTRAINT "voice_providers_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A key someone owns can't be a default for the whole server
ALTER TABLE "voice_providers" ADD CONSTRAINT "voice_providers_owner_not_default" CHECK ("owner_id" IS NULL OR (NOT "default_recognition" AND NOT "default_speech"));

-- CreateTable
CREATE TABLE "voice_key_lends" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "universe_id" TEXT NOT NULL,
    "lent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "models" JSONB,

    CONSTRAINT "voice_key_lends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_key_lends_provider_id_universe_id_key" ON "voice_key_lends"("provider_id", "universe_id");

-- CreateIndex
CREATE INDEX "voice_key_lends_universe_id_idx" ON "voice_key_lends"("universe_id");

-- AddForeignKey
ALTER TABLE "voice_key_lends" ADD CONSTRAINT "voice_key_lends_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "voice_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_key_lends" ADD CONSTRAINT "voice_key_lends_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
