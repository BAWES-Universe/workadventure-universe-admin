-- Keys for Apps (game #2044): an app that runs from a service definition and the owner's key, next to the apps that are an MCP link.
-- Nothing is migrated: every existing app stays kind 'mcp', and no Brick gets anything.

-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "kind" VARCHAR(10) NOT NULL DEFAULT 'mcp',
ADD COLUMN     "definition" JSONB,
ADD COLUMN     "definition_hash" VARCHAR(64),
ADD COLUMN     "key_cipher" TEXT,
ADD COLUMN     "key_last4" VARCHAR(8),
ADD COLUMN     "key_mode" VARCHAR(10),
ADD COLUMN     "key_version" INTEGER NOT NULL DEFAULT 1;

-- A key app is a person's own: it has an owner, a definition and a key, and its source is 'direct', which the lend trigger
-- ("app_lends_only_lendable", source = 'link' only) never lets be lent. A team app can never be one. Nothing else may hold a key.
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_direct_shape" CHECK (
  ("kind" = 'mcp' AND "key_cipher" IS NULL AND "definition" IS NULL)
  OR ("kind" = 'direct' AND "key_cipher" IS NOT NULL AND "definition" IS NOT NULL AND "definition_hash" IS NOT NULL
      AND "owner_id" IS NOT NULL AND "universe_id" IS NULL AND "source" = 'direct' AND "auth_type" = 'none')
);

-- CreateTable
CREATE TABLE "app_key_requests" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "bot_id" VARCHAR(255),
    "connection_id" TEXT,
    "definition" JSONB NOT NULL,
    "definition_hash" VARCHAR(64) NOT NULL,
    "source" VARCHAR(255),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_key_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_key_requests_owner_id_idx" ON "app_key_requests"("owner_id");

-- AddForeignKey
ALTER TABLE "app_key_requests" ADD CONSTRAINT "app_key_requests_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_key_requests" ADD CONSTRAINT "app_key_requests_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
