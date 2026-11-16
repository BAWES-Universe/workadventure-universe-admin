-- A hold remembers which account alone paid for it (work a named payer funds), so a replay of its key can be checked
ALTER TABLE "credit_holds" ADD COLUMN "only_account_id" TEXT;

-- Holds made before this column existed never stored their payer, and it cannot be recovered. They are marked, so a replay of one of them
-- is not refused for a payer nobody recorded; every hold made from now on records its payer (or none) and is checked against it
ALTER TABLE "credit_holds" ADD COLUMN "payer_known" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "credit_holds" ALTER COLUMN "payer_known" SET DEFAULT true;

-- One row per refund request, by its exact key (even a refund that gave nothing back), so asking again answers the same way
CREATE TABLE "credit_refund_requests" (
    "id" TEXT NOT NULL,
    "request_key" VARCHAR(255) NOT NULL,
    "hold_id" TEXT NOT NULL,
    "requested_micros" BIGINT NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "refunded_micros" BIGINT NOT NULL,
    "restored_micros" BIGINT NOT NULL,
    "replacement_micros" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_refund_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_refund_requests_amounts_check" CHECK ("requested_micros" >= 0 AND "refunded_micros" >= 0 AND "restored_micros" >= 0 AND "replacement_micros" >= 0 AND "refunded_micros" = "restored_micros" + "replacement_micros")
);

CREATE UNIQUE INDEX "credit_refund_requests_request_key_key" ON "credit_refund_requests"("request_key");
CREATE INDEX "credit_refund_requests_hold_id_idx" ON "credit_refund_requests"("hold_id");
