-- Reply limits (game #1159): where each person's (or a bot's guests') reply window starts, and who reached a limit on a bot,
-- counted on the bot page (Orbit #491). Two new tables; nothing existing changes.

-- CreateTable
CREATE TABLE "reply_windows" (
    "key" VARCHAR(320) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reply_windows_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "bot_reply_limit_hits" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "talked_user_id" VARCHAR(255) NOT NULL,
    "window_ends_at" TIMESTAMP(3) NOT NULL,
    "asked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_reply_limit_hits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_reply_limit_hits_bot_id_created_at_idx" ON "bot_reply_limit_hits"("bot_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bot_reply_limit_hits_bot_id_kind_talked_user_id_window_ends_key" ON "bot_reply_limit_hits"("bot_id", "kind", "talked_user_id", "window_ends_at");

-- AddForeignKey
ALTER TABLE "bot_reply_limit_hits" ADD CONSTRAINT "bot_reply_limit_hits_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

