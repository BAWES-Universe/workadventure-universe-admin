-- Rules said in chat, held by the server, and one receipt per task for the Activity list (paying spec 3, part O4).
-- Both are new tables: nothing that exists is changed or copied. No foreign keys on purpose, like the meter's books.

-- CreateTable
CREATE TABLE "spend_rules" (
    "id" TEXT NOT NULL,
    "rule_key" VARCHAR(255) NOT NULL,
    "owner_person_id" TEXT NOT NULL,
    "scope" VARCHAR(6) NOT NULL,
    "bot_id" TEXT,
    "task_key" VARCHAR(255),
    "period" VARCHAR(5),
    "cap_micros" BIGINT,
    "only_own_accounts" BOOLEAN NOT NULL DEFAULT false,
    "covers" VARCHAR(8) NOT NULL DEFAULT 'all',
    "words" VARCHAR(300) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" VARCHAR(6) NOT NULL DEFAULT 'active',
    "created_by_id" TEXT NOT NULL,
    "via" VARCHAR(5) NOT NULL DEFAULT 'chat',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "ended_by_id" TEXT,

    CONSTRAINT "spend_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_receipts" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "task_key" VARCHAR(255) NOT NULL,
    "run_id" VARCHAR(255),
    "title" VARCHAR(120) NOT NULL,
    "category" VARCHAR(8),
    "state" VARCHAR(10) NOT NULL DEFAULT 'running',
    "bound_micros" BIGINT,
    "charged_micros" BIGINT,
    "payer_kind" VARCHAR(8) NOT NULL,
    "payer_person_id" TEXT,
    "payer_name" VARCHAR(100),
    "problem_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spend_rules_rule_key_key" ON "spend_rules"("rule_key");

-- CreateIndex
CREATE INDEX "spend_rules_owner_person_id_state_idx" ON "spend_rules"("owner_person_id", "state");

-- CreateIndex
CREATE INDEX "spend_rules_bot_id_state_idx" ON "spend_rules"("bot_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "task_receipts_bot_id_task_key_key" ON "task_receipts"("bot_id", "task_key");

-- CreateIndex
CREATE INDEX "task_receipts_person_id_started_at_idx" ON "task_receipts"("person_id", "started_at");

-- The words the code uses; the database refuses any other
ALTER TABLE "spend_rules" ADD CONSTRAINT "spend_rules_scope_check" CHECK ("scope" IN ('task', 'bot', 'person'));
ALTER TABLE "spend_rules" ADD CONSTRAINT "spend_rules_period_check" CHECK ("period" IS NULL OR "period" IN ('task', 'day', 'month'));
ALTER TABLE "spend_rules" ADD CONSTRAINT "spend_rules_covers_check" CHECK ("covers" IN ('apps', 'computer', 'all'));
ALTER TABLE "spend_rules" ADD CONSTRAINT "spend_rules_state_check" CHECK ("state" IN ('active', 'ended'));
ALTER TABLE "spend_rules" ADD CONSTRAINT "spend_rules_via_check" CHECK ("via" IN ('chat', 'page'));
-- A rule says something: a cap (with how long it counts) or "only my own accounts"
ALTER TABLE "spend_rules" ADD CONSTRAINT "spend_rules_says_check" CHECK (("cap_micros" IS NOT NULL AND "period" IS NOT NULL AND "cap_micros" >= 0) OR ("cap_micros" IS NULL AND "period" IS NULL AND "only_own_accounts"));
-- Where it applies names what it applies to
ALTER TABLE "spend_rules" ADD CONSTRAINT "spend_rules_where_check" CHECK (("scope" = 'person' AND "bot_id" IS NULL AND "task_key" IS NULL) OR ("scope" = 'bot' AND "bot_id" IS NOT NULL AND "task_key" IS NULL) OR ("scope" = 'task' AND "bot_id" IS NOT NULL AND "task_key" IS NOT NULL));
ALTER TABLE "task_receipts" ADD CONSTRAINT "task_receipts_state_check" CHECK ("state" IN ('running', 'done', 'refunded', 'checking'));
ALTER TABLE "task_receipts" ADD CONSTRAINT "task_receipts_category_check" CHECK ("category" IS NULL OR "category" IN ('apps', 'computer'));
ALTER TABLE "task_receipts" ADD CONSTRAINT "task_receipts_payer_check" CHECK ("payer_kind" IN ('person', 'platform', 'sponsor'));
ALTER TABLE "task_receipts" ADD CONSTRAINT "task_receipts_micros_check" CHECK (("bound_micros" IS NULL OR "bound_micros" >= 0) AND ("charged_micros" IS NULL OR "charged_micros" >= 0));
