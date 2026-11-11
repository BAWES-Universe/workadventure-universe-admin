-- The Brick for guests (game #1997). It is Universe's own and has no bot row, so its allowance is counted in its own
-- table: a guest's replies from it never count toward their Universe AI replies for a host's bots, and a host bot's
-- guest pool never counts them. Only totals are kept, never what was said. Nothing is written for anyone here.

-- CreateTable
CREATE TABLE "guest_brick_replies" (
    "id" TEXT NOT NULL,
    "turn_id" VARCHAR(255) NOT NULL,
    "universe_key" VARCHAR(64) NOT NULL,
    "guest_key" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "tokens_used" INTEGER,
    "cost_micros" INTEGER,

    CONSTRAINT "guest_brick_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_brick_handovers" (
    "guest_key" VARCHAR(255) NOT NULL,
    "user_id" TEXT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "carried_at" TIMESTAMP(3),

    CONSTRAINT "guest_brick_handovers_pkey" PRIMARY KEY ("guest_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "guest_brick_replies_turn_id_key" ON "guest_brick_replies"("turn_id");

-- CreateIndex
CREATE INDEX "guest_brick_replies_universe_key_created_at_idx" ON "guest_brick_replies"("universe_key", "created_at");

-- CreateIndex
CREATE INDEX "guest_brick_replies_guest_key_created_at_idx" ON "guest_brick_replies"("guest_key", "created_at");

-- CreateIndex
CREATE INDEX "guest_brick_handovers_user_id_idx" ON "guest_brick_handovers"("user_id");

-- AddForeignKey
ALTER TABLE "guest_brick_handovers" ADD CONSTRAINT "guest_brick_handovers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
