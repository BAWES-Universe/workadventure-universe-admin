-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "provider_account_id" VARCHAR(255),
ADD COLUMN     "provider_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "provider_toolkit" VARCHAR(60);

-- CreateIndex
CREATE UNIQUE INDEX "app_connections_owner_id_provider_toolkit_key" ON "app_connections"("owner_id", "provider_toolkit");

