-- Bot voice (#740): voice on or off for each bot, its draft voice profile and its published revisions.
--
-- Nothing changes for anyone: every bot starts with voice off and no revision.

-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "voice_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "voice_revision" INTEGER;

-- CreateTable
CREATE TABLE "bot_voice_drafts" (
    "bot_id" TEXT NOT NULL,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "updated_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_voice_drafts_pkey" PRIMARY KEY ("bot_id")
);

-- CreateTable
CREATE TABLE "bot_voice_revisions" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "profile" JSONB NOT NULL,
    "note" VARCHAR(500),
    "published_by_id" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_voice_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_voice_revisions_bot_id_number_key" ON "bot_voice_revisions"("bot_id", "number");

-- AddForeignKey
ALTER TABLE "bot_voice_drafts" ADD CONSTRAINT "bot_voice_drafts_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_voice_revisions" ADD CONSTRAINT "bot_voice_revisions_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
