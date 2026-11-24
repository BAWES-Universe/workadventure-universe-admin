-- The bounded Instant executor (O2): the books of every paid Instant run and the give-backs after it. New tables only; nothing that
-- exists is changed.
CREATE TABLE "instant_runs" (
    "id" TEXT NOT NULL,
    "run_key" VARCHAR(255) NOT NULL,
    "bot_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "tool_slug" VARCHAR(120) NOT NULL,
    "toolkit" VARCHAR(80) NOT NULL,
    "args_hash" VARCHAR(64) NOT NULL,
    "price_version" VARCHAR(40) NOT NULL,
    "top_micros" BIGINT NOT NULL,
    "hold_micros" BIGINT NOT NULL,
    "markup_bps" INTEGER,
    "state" VARCHAR(12) NOT NULL,
    "reason" VARCHAR(40),
    "customer_state" VARCHAR(10) NOT NULL DEFAULT 'none',
    "customer_micros" BIGINT,
    "refunded_micros" BIGINT NOT NULL DEFAULT 0,
    "provider_state" VARCHAR(10) NOT NULL DEFAULT 'none',
    "provider_micros" BIGINT,
    "provider_basis" VARCHAR(10),
    "provider_log_id" VARCHAR(255),
    "provider_user_id" VARCHAR(120) NOT NULL,
    "provider" VARCHAR(20) NOT NULL DEFAULT 'composio',
    "sent_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "check_after" TIMESTAMP(3),
    "checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB,

    CONSTRAINT "instant_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instant_runs_run_key_key" ON "instant_runs"("run_key");
CREATE INDEX "instant_runs_state_created_at_idx" ON "instant_runs"("state", "created_at");
CREATE INDEX "instant_runs_provider_state_created_at_idx" ON "instant_runs"("provider_state", "created_at");
CREATE INDEX "instant_runs_person_id_created_at_idx" ON "instant_runs"("person_id", "created_at");
CREATE INDEX "instant_runs_person_id_args_hash_state_idx" ON "instant_runs"("person_id", "args_hash", "state");

ALTER TABLE "instant_runs" ADD CONSTRAINT "instant_runs_state_check" CHECK ("state" IN ('reserving', 'held', 'sent', 'succeeded', 'failed', 'ambiguous', 'refused'));
ALTER TABLE "instant_runs" ADD CONSTRAINT "instant_runs_customer_state_check" CHECK ("customer_state" IN ('none', 'held', 'charged', 'released'));
ALTER TABLE "instant_runs" ADD CONSTRAINT "instant_runs_provider_state_check" CHECK ("provider_state" IN ('none', 'pending', 'settled'));
ALTER TABLE "instant_runs" ADD CONSTRAINT "instant_runs_provider_basis_check" CHECK ("provider_basis" IS NULL OR "provider_basis" IN ('measured', 'estimated'));
ALTER TABLE "instant_runs" ADD CONSTRAINT "instant_runs_money_check" CHECK ("top_micros" >= 0 AND "hold_micros" >= 0 AND "refunded_micros" >= 0 AND ("customer_micros" IS NULL OR "customer_micros" >= 0) AND ("provider_micros" IS NULL OR "provider_micros" >= 0));

CREATE TABLE "instant_refunds" (
    "id" TEXT NOT NULL,
    "refund_key" VARCHAR(255) NOT NULL,
    "run_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instant_refunds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instant_refunds_refund_key_key" ON "instant_refunds"("refund_key");
CREATE INDEX "instant_refunds_run_id_idx" ON "instant_refunds"("run_id");
CREATE INDEX "instant_refunds_person_id_created_at_idx" ON "instant_refunds"("person_id", "created_at");
CREATE INDEX "instant_refunds_created_at_idx" ON "instant_refunds"("created_at");

ALTER TABLE "instant_refunds" ADD CONSTRAINT "instant_refunds_kind_check" CHECK ("kind" IN ('goodwill', 'late_fix'));
ALTER TABLE "instant_refunds" ADD CONSTRAINT "instant_refunds_amount_check" CHECK ("amount_micros" > 0);

CREATE TABLE "instant_session_checks" (
    "connection_id" TEXT NOT NULL,
    "session_id" VARCHAR(255) NOT NULL,
    "state" VARCHAR(10) NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instant_session_checks_pkey" PRIMARY KEY ("connection_id")
);

ALTER TABLE "instant_session_checks" ADD CONSTRAINT "instant_session_checks_state_check" CHECK ("state" IN ('denied', 'gone', 'failed'));
