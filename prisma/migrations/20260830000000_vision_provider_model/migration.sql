-- Vision config moved from bot level to provider level (Option B):
-- bots no longer carry a per-bot vision fallback; providers declare their
-- own vision model and which one is the default vision provider.

-- AlterTable
ALTER TABLE "bots" DROP COLUMN "vision_fallback_model",
DROP COLUMN "vision_fallback_provider_ref";

-- AlterTable
ALTER TABLE "bots_ai_providers" ADD COLUMN     "vision_model" VARCHAR(255),
ADD COLUMN     "default_vision" BOOLEAN NOT NULL DEFAULT false;
