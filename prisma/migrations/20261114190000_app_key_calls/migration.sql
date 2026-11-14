-- Keys for Apps (game #2044), step 2: one row for each use of a key app by a Brick. Nothing is migrated.

-- CreateTable
CREATE TABLE "app_key_calls" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "call_id" VARCHAR(200) NOT NULL,
    "operation" VARCHAR(60) NOT NULL,
    "state" VARCHAR(10) NOT NULL DEFAULT 'sending',
    "http_status" INTEGER,
    "outcome" VARCHAR(12),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_key_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_key_calls_bot_id_call_id_key" ON "app_key_calls"("bot_id", "call_id");

-- CreateIndex
CREATE INDEX "app_key_calls_owner_id_created_at_idx" ON "app_key_calls"("owner_id", "created_at");

-- CreateIndex
CREATE INDEX "app_key_calls_created_at_idx" ON "app_key_calls"("created_at");

-- AddForeignKey
ALTER TABLE "app_key_calls" ADD CONSTRAINT "app_key_calls_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
