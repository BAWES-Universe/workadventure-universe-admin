-- A refund of the credit a failed computer job drew is owed until the funding books acknowledge it: kept once per hold, with the amount fixed, outliving the job
-- and the Brick. A new table only (no change to a populated table, no foreign key, no backfill: the sweep records what is owed for jobs that failed before).
CREATE TABLE "computer_refund_obligations" (
    "id" TEXT NOT NULL,
    "job_id" VARCHAR(255) NOT NULL,
    "person_id" TEXT NOT NULL,
    "hold_key" VARCHAR(255) NOT NULL,
    "refund_key" VARCHAR(255) NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "state" VARCHAR(12) NOT NULL DEFAULT 'owed',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "last_error" VARCHAR(200),
    "next_attempt_at" TIMESTAMP(3),
    "alerted_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_micros" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "computer_refund_obligations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_refund_obligations_hold_key_key" ON "computer_refund_obligations"("hold_key");
CREATE INDEX "computer_refund_obligations_state_next_attempt_at_idx" ON "computer_refund_obligations"("state", "next_attempt_at");
CREATE INDEX "computer_refund_obligations_job_id_idx" ON "computer_refund_obligations"("job_id");
