-- Apps a person connects once (#2001). A connection belongs to one person; a Brick of theirs uses it through a grant, which is
-- a bot_mcp_servers row with connection_id set. Rows without it (every app set up on a bot today) are untouched, and nothing is
-- migrated: no bot gets a connection by default.

-- AlterTable
ALTER TABLE "bot_mcp_servers" ADD COLUMN     "connection_id" TEXT;

-- CreateTable
CREATE TABLE "app_connections" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "server_url" TEXT NOT NULL,
    "auth_type" VARCHAR(20) NOT NULL DEFAULT 'none',
    "auth_config" TEXT,
    "headers" JSONB,
    "source" VARCHAR(20) NOT NULL DEFAULT 'link',
    "sign_in_nonce" VARCHAR(64),
    "refresh_lease_until" TIMESTAMP(3),
    "sign_in_lost_at" TIMESTAMP(3),
    "sign_in_lost_status" INTEGER,
    "no_answer_at" TIMESTAMP(3),
    "reconnected_at" TIMESTAMP(3),
    "connected_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_connections_owner_id_idx" ON "app_connections"("owner_id");

-- CreateIndex
CREATE INDEX "bot_mcp_servers_connection_id_idx" ON "bot_mcp_servers"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_mcp_servers_bot_id_connection_id_key" ON "bot_mcp_servers"("bot_id", "connection_id");

-- AddForeignKey
ALTER TABLE "bot_mcp_servers" ADD CONSTRAINT "bot_mcp_servers_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A grant is only ever from a person to their own Brick: a room bot, or a Brick of someone else, can never hold one, whatever
-- code asks. (A person's connection is never lent to a room or a team here: those are a later step with their own screens.)
CREATE OR REPLACE FUNCTION "bot_mcp_servers_grant_is_owners"() RETURNS trigger AS $$
BEGIN
  IF NEW."connection_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "bots" b
    JOIN "app_connections" c ON c."id" = NEW."connection_id"
    WHERE b."id" = NEW."bot_id" AND b."room_id" IS NULL AND b."owner_id" = c."owner_id"
  ) THEN
    RAISE EXCEPTION 'A connection can only be used by its owner''s own Bricks' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "bot_mcp_servers_grant_is_owners_trigger"
BEFORE INSERT OR UPDATE OF "bot_id", "connection_id" ON "bot_mcp_servers"
FOR EACH ROW EXECUTE FUNCTION "bot_mcp_servers_grant_is_owners"();
