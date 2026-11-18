-- AlterTable
ALTER TABLE "computer_jobs" ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "paused_for" VARCHAR(10),
ADD COLUMN     "paused_need_micros" BIGINT,
ADD COLUMN     "paused_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resume_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "computer_call_authorisations" (
    "id" TEXT NOT NULL,
    "call_key" VARCHAR(255) NOT NULL,
    "job_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "operation_id" VARCHAR(80) NOT NULL,
    "contract" INTEGER NOT NULL,
    "payer_kind" VARCHAR(10) NOT NULL,
    "funding_account_id" VARCHAR(64),
    "tariff_version" VARCHAR(64),
    "limits" JSONB NOT NULL,
    "route" VARCHAR(12) NOT NULL,
    "model" VARCHAR(120) NOT NULL DEFAULT '',
    "model_format" VARCHAR(20) NOT NULL DEFAULT 'openai',
    "step_kind" VARCHAR(10) NOT NULL DEFAULT 'other',
    "input_tokens" INTEGER NOT NULL,
    "input_micros" BIGINT NOT NULL,
    "output_micros_per_million" BIGINT NOT NULL,
    "max_output_tokens" INTEGER NOT NULL,
    "member_micros" BIGINT NOT NULL,
    "provider_max_micros" BIGINT NOT NULL,
    "state" VARCHAR(10) NOT NULL DEFAULT 'held',
    "output_tokens" INTEGER,
    "charged_micros" BIGINT,
    "provider_cost_micros" BIGINT,
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "computer_call_authorisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "computer_models_seen" (
    "id" TEXT NOT NULL,
    "route" VARCHAR(12) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "priced" BOOLEAN NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_models_seen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "computer_call_authorisations_call_key_key" ON "computer_call_authorisations"("call_key");

-- CreateIndex
CREATE INDEX "computer_call_authorisations_job_id_route_model_step_kind_s_idx" ON "computer_call_authorisations"("job_id", "route", "model", "step_kind", "state", "settled_at");

-- CreateIndex
CREATE INDEX "computer_call_authorisations_person_id_created_at_idx" ON "computer_call_authorisations"("person_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "computer_models_seen_route_model_key" ON "computer_models_seen"("route", "model");


-- A late receipt that lowers what an unknown step charged goes back into the lots the charge came from, as a correction (not a failure, not goodwill)
ALTER TABLE "credit_refunds" DROP CONSTRAINT "credit_refunds_reason_check";
ALTER TABLE "credit_refunds" ADD CONSTRAINT "credit_refunds_reason_check" CHECK ("reason" IN ('platform_failure', 'goodwill', 'redelivery', 'correction'));
