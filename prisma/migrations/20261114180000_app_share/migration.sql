-- Other people asking a Brick for a job from an app of its owner's (#2006). Nothing is migrated: no app is shared until its owner
-- lets people ask, and what they may ask for is only the jobs the owner picks. Deleting the grant, the app or the share stops all.

-- CreateTable
CREATE TABLE "app_shares" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "shared_by_id" TEXT,
    "uses_per_day_everyone" INTEGER NOT NULL,
    "uses_per_day_person" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_share_jobs" (
    "id" TEXT NOT NULL,
    "share_id" TEXT NOT NULL,
    "tool_name" VARCHAR(255) NOT NULL,
    "fingerprint" VARCHAR(128) NOT NULL,
    "inputs" JSONB NOT NULL,
    "returns" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_share_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_share_uses" (
    "id" TEXT NOT NULL,
    "share_id" TEXT NOT NULL,
    "call_id" VARCHAR(200) NOT NULL,
    "asker_key" VARCHAR(320) NOT NULL,
    "tool_name" VARCHAR(255) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'running',
    "retries" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "app_share_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_shares_server_id_key" ON "app_shares"("server_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_share_jobs_share_id_tool_name_key" ON "app_share_jobs"("share_id", "tool_name");

-- CreateIndex
CREATE INDEX "app_share_uses_share_id_created_at_idx" ON "app_share_uses"("share_id", "created_at");

-- CreateIndex
CREATE INDEX "app_share_uses_share_id_asker_key_created_at_idx" ON "app_share_uses"("share_id", "asker_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "app_share_uses_share_id_call_id_key" ON "app_share_uses"("share_id", "call_id");

-- AddForeignKey
ALTER TABLE "app_shares" ADD CONSTRAINT "app_shares_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "bot_mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_shares" ADD CONSTRAINT "app_shares_shared_by_id_fkey" FOREIGN KEY ("shared_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_share_jobs" ADD CONSTRAINT "app_share_jobs_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "app_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_share_uses" ADD CONSTRAINT "app_share_uses_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "app_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A share is only ever on a Brick's grant of its own owner's app, and never on one signed in as the person (a sign-in page, a listed
-- app or a ready-made app): sharing that would let others act as them. A ready-made, narrow job Universe has reviewed is the one
-- exception, and it is added with the job itself. The numbers are whole and above zero, and the database holds them too.
ALTER TABLE "app_shares" ADD CONSTRAINT "app_shares_limits_positive" CHECK ("uses_per_day_everyone" >= 1 AND "uses_per_day_person" >= 1);
ALTER TABLE "app_share_uses" ADD CONSTRAINT "app_share_uses_status_known" CHECK ("status" IN ('running', 'done', 'unknown', 'refunded'));

CREATE OR REPLACE FUNCTION "app_shares_on_own_plain_app"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "bot_mcp_servers" g
    JOIN "bots" b ON b."id" = g."bot_id"
    JOIN "app_connections" c ON c."id" = g."connection_id"
    WHERE g."id" = NEW."server_id" AND b."room_id" IS NULL AND c."owner_id" IS NOT NULL AND b."owner_id" = c."owner_id"
      AND c."source" = 'link' AND c."auth_type" <> 'oauth'
  ) THEN
    RAISE EXCEPTION 'Only a Brick''s use of its owner''s own app, not signed in as the owner, can be shared' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "app_shares_on_own_plain_app_trg" BEFORE INSERT ON "app_shares" FOR EACH ROW EXECUTE FUNCTION "app_shares_on_own_plain_app"();
