-- Lending an app to a universe, and a universe's own apps (#2001 step 7, mock approved 13 Nov). A person's app has an owner; a
-- universe's own app has a universe and no owner, so it stays when anyone leaves. Nothing is migrated and no bot gets an app.

-- AlterTable
ALTER TABLE "app_connections" ADD COLUMN     "universe_id" TEXT,
ALTER COLUMN "owner_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "app_lends" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "universe_id" TEXT NOT NULL,
    "lent_by_id" TEXT,
    "things" JSONB,
    "uses_per_day" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_lends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_connection_managers" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "added_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_connection_managers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_uses" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "universe_id" TEXT NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "call_id" VARCHAR(200) NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_lends_universe_id_idx" ON "app_lends"("universe_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_lends_connection_id_universe_id_key" ON "app_lends"("connection_id", "universe_id");

-- CreateIndex
CREATE INDEX "app_connection_managers_user_id_idx" ON "app_connection_managers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_connection_managers_connection_id_user_id_key" ON "app_connection_managers"("connection_id", "user_id");

-- CreateIndex
CREATE INDEX "app_uses_connection_id_universe_id_used_at_idx" ON "app_uses"("connection_id", "universe_id", "used_at");

-- CreateIndex
CREATE UNIQUE INDEX "app_uses_connection_id_bot_id_call_id_key" ON "app_uses"("connection_id", "bot_id", "call_id");

-- CreateIndex
CREATE INDEX "app_connections_universe_id_idx" ON "app_connections"("universe_id");

-- AddForeignKey
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_lends" ADD CONSTRAINT "app_lends_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_lends" ADD CONSTRAINT "app_lends_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_lends" ADD CONSTRAINT "app_lends_lent_by_id_fkey" FOREIGN KEY ("lent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_connection_managers" ADD CONSTRAINT "app_connection_managers_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_connection_managers" ADD CONSTRAINT "app_connection_managers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_connection_managers" ADD CONSTRAINT "app_connection_managers_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_uses" ADD CONSTRAINT "app_uses_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A connection belongs to exactly one of a person or a universe
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_owner_xor_universe" CHECK (("owner_id" IS NOT NULL) <> ("universe_id" IS NOT NULL));

-- Who may hold a grant, whatever code asks: a Brick of the person whose app it is; a room bot in the universe a universe's own app
-- belongs to; a room bot in a universe the person's app is lent to. Nothing else.
CREATE OR REPLACE FUNCTION "bot_mcp_servers_grant_is_owners"() RETURNS trigger AS $$
BEGIN
  IF NEW."connection_id" IS NOT NULL AND NOT (
    EXISTS (
      SELECT 1 FROM "bots" b JOIN "app_connections" c ON c."id" = NEW."connection_id"
      WHERE b."id" = NEW."bot_id" AND b."room_id" IS NULL AND c."owner_id" IS NOT NULL AND b."owner_id" = c."owner_id"
    )
    OR EXISTS (
      SELECT 1 FROM "bots" b
      JOIN "rooms" r ON r."id" = b."room_id"
      JOIN "worlds" w ON w."id" = r."world_id"
      JOIN "app_connections" c ON c."id" = NEW."connection_id"
      WHERE b."id" = NEW."bot_id" AND c."universe_id" IS NOT NULL AND w."universe_id" = c."universe_id"
    )
    OR EXISTS (
      SELECT 1 FROM "bots" b
      JOIN "rooms" r ON r."id" = b."room_id"
      JOIN "worlds" w ON w."id" = r."world_id"
      JOIN "app_lends" l ON l."connection_id" = NEW."connection_id" AND l."universe_id" = w."universe_id"
      WHERE b."id" = NEW."bot_id"
    )
  ) THEN
    RAISE EXCEPTION 'A connection can only be used by its owner''s own Bricks, bots of the universe that owns it, or bots of a universe it is lent to' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only an app a person added with a link and a key, a token or nothing can be lent: one signed in as the person (a sign-in page, a
-- listed or ready-made app) stays theirs alone.
CREATE OR REPLACE FUNCTION "app_lends_only_lendable"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "app_connections" c
    WHERE c."id" = NEW."connection_id" AND c."owner_id" IS NOT NULL AND c."source" = 'link' AND c."auth_type" <> 'oauth'
  ) THEN
    RAISE EXCEPTION 'Only an app a person added with a key or a link, not signed in as them, can be lent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "app_lends_only_lendable_trigger"
BEFORE INSERT ON "app_lends"
FOR EACH ROW EXECUTE FUNCTION "app_lends_only_lendable"();
