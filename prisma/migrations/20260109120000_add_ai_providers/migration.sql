-- CreateTable
CREATE TABLE "bots_ai_providers" (
    "provider_id" VARCHAR(50) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "endpoint" TEXT,
    "api_key_encrypted" TEXT,
    "model" VARCHAR(255),
    "temperature" DECIMAL(3,2) DEFAULT 0.7,
    "max_tokens" INTEGER DEFAULT 500,
    "supports_streaming" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB DEFAULT '{}',
    "tested" BOOLEAN NOT NULL DEFAULT false,
    "tested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bots_ai_providers_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "bots_ai_usage" (
    "id" SERIAL NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "provider_id" VARCHAR(50) NOT NULL,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "api_calls" INTEGER NOT NULL DEFAULT 1,
    "duration_seconds" INTEGER,
    "cost" DECIMAL(10,4),
    "latency" INTEGER,
    "error" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bots_ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bots_ai_providers_enabled_idx" ON "bots_ai_providers"("enabled");

-- CreateIndex
CREATE INDEX "bots_ai_providers_type_idx" ON "bots_ai_providers"("type");

-- CreateIndex
CREATE INDEX "bots_ai_usage_bot_id_idx" ON "bots_ai_usage"("bot_id");

-- CreateIndex
CREATE INDEX "bots_ai_usage_provider_id_idx" ON "bots_ai_usage"("provider_id");

-- CreateIndex
CREATE INDEX "bots_ai_usage_timestamp_idx" ON "bots_ai_usage"("timestamp");

-- CreateIndex
CREATE INDEX "bots_ai_usage_bot_id_provider_id_timestamp_idx" ON "bots_ai_usage"("bot_id", "provider_id", "timestamp");

-- AddForeignKey
ALTER TABLE "bots_ai_usage" ADD CONSTRAINT "bots_ai_usage_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "bots_ai_providers"("provider_id") ON DELETE CASCADE ON UPDATE CASCADE;

