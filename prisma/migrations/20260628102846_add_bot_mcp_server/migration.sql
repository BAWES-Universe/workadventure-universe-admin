-- CreateTable
CREATE TABLE "bot_mcp_servers" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "server_url" TEXT NOT NULL,
    "auth_type" VARCHAR(20) NOT NULL DEFAULT 'none',
    "auth_config" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_mcp_servers_bot_id_idx" ON "bot_mcp_servers"("bot_id");

-- AddForeignKey
ALTER TABLE "bot_mcp_servers" ADD CONSTRAINT "bot_mcp_servers_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
