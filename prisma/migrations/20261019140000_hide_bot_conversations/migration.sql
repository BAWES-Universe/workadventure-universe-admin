-- Hide bot conversations (#435).
--
-- Nobody gains or loses anything: every universe starts with the setting off and every bot follows its universe, so
-- every page, API and bot-server call answers exactly as it did. Bots keep remembering people either way.

-- AlterTable
ALTER TABLE "universes" ADD COLUMN     "hide_bot_conversations" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "hide_conversations" BOOLEAN;

-- CreateTable
CREATE TABLE "bot_memory_forgets" (
    "id" TEXT NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "user_uuid" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reported_at" TIMESTAMP(3),

    CONSTRAINT "bot_memory_forgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_memory_forgets_bot_id_idx" ON "bot_memory_forgets"("bot_id");
