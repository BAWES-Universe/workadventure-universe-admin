-- Voice providers (#740): the speech companies a super admin sets up for the whole server.
--
-- A new table and nothing else: no bot, key or provider that exists today is touched.

-- CreateTable
CREATE TABLE "voice_providers" (
    "id" TEXT NOT NULL,
    "adapter" VARCHAR(50) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "recognition" BOOLEAN NOT NULL DEFAULT false,
    "speech" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "endpoint" TEXT,
    "region" VARCHAR(50),
    "api_key_encrypted" TEXT,
    "api_key_last4" VARCHAR(4),
    "models" JSONB NOT NULL DEFAULT '[]',
    "default_recognition" BOOLEAN NOT NULL DEFAULT false,
    "default_speech" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_providers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_providers_enabled_idx" ON "voice_providers"("enabled");

-- At most one default for listening and one for speaking
CREATE UNIQUE INDEX "voice_providers_default_recognition_key" ON "voice_providers"("default_recognition") WHERE "default_recognition";
CREATE UNIQUE INDEX "voice_providers_default_speech_key" ON "voice_providers"("default_speech") WHERE "default_speech";
