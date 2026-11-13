
-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "catalog_key" VARCHAR(60);

-- CreateTable
CREATE TABLE "app_catalog_entries" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "blurb" VARCHAR(200) NOT NULL,
    "icon" VARCHAR(60) NOT NULL DEFAULT 'plug',
    "server_url" TEXT NOT NULL,
    "auth_type" VARCHAR(20) NOT NULL DEFAULT 'oauth',
    "auth_config" TEXT,
    "headers" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_catalog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_catalog_entries_key_key" ON "app_catalog_entries"("key");

-- CreateIndex
CREATE UNIQUE INDEX "app_connections_owner_id_catalog_key_key" ON "app_connections"("owner_id", "catalog_key");

