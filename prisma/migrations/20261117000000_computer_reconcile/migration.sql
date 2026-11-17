-- The daily check of our books against the computer provider's bill (0.5.0 gap T3). One row per UTC day. Nothing is migrated.

-- CreateTable
CREATE TABLE "computer_reconciles" (
    "id" TEXT NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_total_micros" BIGINT NOT NULL,
    "agent_brick_micros" BIGINT NOT NULL,
    "our_minutes" INTEGER NOT NULL,
    "agent_minutes" INTEGER NOT NULL,
    "status" VARCHAR(5) NOT NULL,
    "gap_micros" BIGINT NOT NULL,
    "findings" JSONB NOT NULL,

    CONSTRAINT "computer_reconciles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "computer_reconciles_day_key" ON "computer_reconciles"("day");
