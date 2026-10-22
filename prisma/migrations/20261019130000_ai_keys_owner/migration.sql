-- Personal AI keys (#374, part 1): a provider row can belong to a person.
--
-- Both columns are new and empty, so every provider row there is today keeps owner_id NULL, which means "the super
-- admin's server-wide provider", exactly what it is now. Nothing existing is rewritten.

-- AlterTable
ALTER TABLE "bots_ai_providers" ADD COLUMN "owner_id" TEXT,
ADD COLUMN "api_key_last4" VARCHAR(4);

-- CreateIndex
CREATE INDEX "bots_ai_providers_owner_id_idx" ON "bots_ai_providers"("owner_id");

-- AddForeignKey
ALTER TABLE "bots_ai_providers" ADD CONSTRAINT "bots_ai_providers_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
