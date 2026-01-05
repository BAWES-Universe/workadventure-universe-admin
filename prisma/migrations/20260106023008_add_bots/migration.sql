-- CreateTable
CREATE TABLE "bots" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "character_texture_id" VARCHAR(100),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "behavior_type" VARCHAR(20) NOT NULL DEFAULT 'idle',
    "behavior_config" JSONB NOT NULL DEFAULT '{}',
    "chat_instructions" TEXT,
    "movement_instructions" TEXT,
    "ai_provider_ref" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bots_room_id_idx" ON "bots"("room_id");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

