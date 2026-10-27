-- Configurable bot limits (Orbit #666): one table for settings a super admin changes in Orbit, and a bot's own reply
-- limits. Nothing is saved at first, so every limit reads its recommended value until someone changes it.

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- AlterTable
ALTER TABLE "bots" ADD COLUMN "max_reply_tokens" INTEGER,
ADD COLUMN "max_steps" INTEGER;

-- AlterTable
ALTER TABLE "bots_ai_providers" ADD COLUMN "reply_limits" JSONB;
