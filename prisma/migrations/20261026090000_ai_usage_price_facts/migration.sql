-- What a bot reply cost and how it was worked out (game #1173). Nine new columns that start empty; every existing row
-- keeps its old estimate in "cost" exactly as it was, and an empty "cost_basis" is how a row says it is one.

-- AlterTable
ALTER TABLE "bots_ai_usage" ADD COLUMN     "input_tokens" INTEGER,
ADD COLUMN     "cached_tokens" INTEGER,
ADD COLUMN     "cache_write_tokens" INTEGER,
ADD COLUMN     "output_tokens" INTEGER,
ADD COLUMN     "reasoning_tokens" INTEGER,
ADD COLUMN     "cost_micros" INTEGER,
ADD COLUMN     "cost_basis" VARCHAR(20),
ADD COLUMN     "price_source" VARCHAR(60),
ADD COLUMN     "price_version" VARCHAR(60);
