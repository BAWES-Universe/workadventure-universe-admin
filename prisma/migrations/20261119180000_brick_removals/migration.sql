-- Bricks removed for good, kept a few days so the bot server hears of each one on its next sweep
CREATE TABLE "brick_removals" (
    "bot_id" VARCHAR(255) NOT NULL,
    "removed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brick_removals_pkey" PRIMARY KEY ("bot_id")
);

CREATE INDEX "brick_removals_removed_at_idx" ON "brick_removals"("removed_at");
