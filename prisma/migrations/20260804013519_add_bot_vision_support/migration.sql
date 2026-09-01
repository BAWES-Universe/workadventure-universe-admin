-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "vision_fallback_model" VARCHAR(255),
ADD COLUMN     "vision_fallback_provider_ref" VARCHAR(100);

-- AlterTable
ALTER TABLE "bots_ai_providers" ADD COLUMN     "supports_vision" BOOLEAN;
