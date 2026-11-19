-- A save of a Brick's computer folder that is under way, written down before it starts: a purge that finds one cannot call the saved files gone.
CREATE TABLE "saved_copy_writes" (
    "id" TEXT NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_copy_writes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_copy_writes_bot_id_idx" ON "saved_copy_writes"("bot_id");
