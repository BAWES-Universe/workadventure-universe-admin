-- AlterTable
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "created_by_id" TEXT;
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "updated_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

