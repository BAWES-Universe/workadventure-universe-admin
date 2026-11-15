-- Funding books (paying spec v3, section 16, O1). Funding accounts, categories, grant programs with versioned rules, recipients, issued
-- credit lots (exactly once per program + person or pool + period), holds with the lots they took from, and refunds that keep their
-- source. Customer credit is kept apart from what a provider bills us. Nothing that exists today is touched or copied in: today's
-- reply windows, the computer allowance and the 2x, 5x and no-limit extras (meter_grants) keep their meaning. Nothing is issued by
-- this migration: no program exists until a super admin saves one, so nobody receives anything until Khalid sets the values.

-- CreateTable
CREATE TABLE "credit_categories" (
    "id" VARCHAR(30) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "benefit" VARCHAR(10) NOT NULL,
    "unit" VARCHAR(12) NOT NULL,
    "pays" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_accounts" (
    "id" TEXT NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "owner_key" VARCHAR(255) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "budget_micros" BIGINT,
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_account_admins" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "added_by_id" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_account_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_programs" (
    "id" TEXT NOT NULL,
    "category_id" VARCHAR(30) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_key" VARCHAR(255),
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "grant_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_rules" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" VARCHAR(12) NOT NULL DEFAULT 'current',
    "funding_account_id" TEXT NOT NULL,
    "covers" TEXT[],
    "benefit_kind" VARCHAR(12) NOT NULL,
    "amount" BIGINT NOT NULL,
    "schedule" VARCHAR(8) NOT NULL,
    "share" VARCHAR(8) NOT NULL,
    "recipient_type" VARCHAR(10) NOT NULL,
    "recipient_from" TIMESTAMP(3),
    "recipient_to" TIMESTAMP(3),
    "recipient_universe_id" TEXT,
    "recipient_mode" VARCHAR(10),
    "joiner_cap" INTEGER,
    "total_cap_micros" BIGINT,
    "claim_starts_at" TIMESTAMP(3) NOT NULL,
    "claim_ends_at" TIMESTAMP(3),
    "lot_expires_at" TIMESTAMP(3),
    "lot_expires_in_days" INTEGER,
    "settlement" VARCHAR(10) NOT NULL DEFAULT 'free',
    "agreement_note" VARCHAR(1000),
    "agreement_ref" VARCHAR(120),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "grant_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_recipients" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "grant_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_lots" (
    "id" TEXT NOT NULL,
    "slot_key" VARCHAR(140) NOT NULL,
    "subject_key" VARCHAR(320) NOT NULL,
    "period_key" VARCHAR(40) NOT NULL,
    "program_id" TEXT,
    "rule_id" TEXT,
    "rule_version" INTEGER,
    "funding_account_id" TEXT NOT NULL,
    "person_id" TEXT,
    "source" VARCHAR(16) NOT NULL,
    "unit" VARCHAR(12) NOT NULL DEFAULT 'usd_micros',
    "amount_micros" BIGINT NOT NULL,
    "covers" TEXT[],
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "settlement" VARCHAR(10) NOT NULL DEFAULT 'free',
    "billed_at" TIMESTAMP(3),
    "refund_of_hold_id" TEXT,
    "note" VARCHAR(1000),

    CONSTRAINT "credit_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_holds" (
    "id" TEXT NOT NULL,
    "hold_key" VARCHAR(255) NOT NULL,
    "person_id" TEXT NOT NULL,
    "bot_id" TEXT,
    "asker_key" VARCHAR(320),
    "category" VARCHAR(30) NOT NULL,
    "charge_class" VARCHAR(20) NOT NULL,
    "price_version" VARCHAR(40),
    "route" VARCHAR(40),
    "provider" VARCHAR(40),
    "job_key" VARCHAR(255),
    "parent_hold_key" VARCHAR(255),
    "effect_key" VARCHAR(255),
    "state" VARCHAR(10) NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "customer_micros" BIGINT,
    "refunded_micros" BIGINT NOT NULL DEFAULT 0,
    "provider_cost_micros" BIGINT,
    "provider_cost_basis" VARCHAR(16),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "detail" JSONB,

    CONSTRAINT "credit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_allocations" (
    "id" TEXT NOT NULL,
    "hold_id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "settled_micros" BIGINT,
    "state" VARCHAR(10) NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_refunds" (
    "id" TEXT NOT NULL,
    "refund_key" VARCHAR(255) NOT NULL,
    "hold_id" TEXT NOT NULL,
    "allocation_id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "mode" VARCHAR(12) NOT NULL,
    "replacement_lot_id" TEXT,
    "reason" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "funding_accounts_kind_owner_key_key" ON "funding_accounts"("kind", "owner_key");

-- CreateIndex
CREATE INDEX "funding_account_admins_user_id_idx" ON "funding_account_admins"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "funding_account_admins_account_id_user_id_key" ON "funding_account_admins"("account_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "grant_programs_request_key_key" ON "grant_programs"("request_key");

-- CreateIndex
CREATE INDEX "grant_programs_category_id_kind_status_idx" ON "grant_programs"("category_id", "kind", "status");

-- CreateIndex
CREATE INDEX "grant_rules_state_recipient_type_idx" ON "grant_rules"("state", "recipient_type");

-- CreateIndex
CREATE UNIQUE INDEX "grant_rules_program_id_version_key" ON "grant_rules"("program_id", "version");

-- CreateIndex
CREATE INDEX "grant_recipients_user_id_idx" ON "grant_recipients"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "grant_recipients_rule_id_user_id_key" ON "grant_recipients"("rule_id", "user_id");

-- CreateIndex
CREATE INDEX "credit_lots_person_id_expires_at_idx" ON "credit_lots"("person_id", "expires_at");

-- CreateIndex
CREATE INDEX "credit_lots_funding_account_id_issued_at_idx" ON "credit_lots"("funding_account_id", "issued_at");

-- CreateIndex
CREATE INDEX "credit_lots_program_id_idx" ON "credit_lots"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_lots_slot_key_subject_key_period_key_key" ON "credit_lots"("slot_key", "subject_key", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_holds_hold_key_key" ON "credit_holds"("hold_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_holds_effect_key_key" ON "credit_holds"("effect_key");

-- CreateIndex
CREATE INDEX "credit_holds_person_id_state_idx" ON "credit_holds"("person_id", "state");

-- CreateIndex
CREATE INDEX "credit_holds_job_key_idx" ON "credit_holds"("job_key");

-- CreateIndex
CREATE INDEX "credit_holds_state_expires_at_idx" ON "credit_holds"("state", "expires_at");

-- CreateIndex
CREATE INDEX "credit_holds_category_created_at_idx" ON "credit_holds"("category", "created_at");

-- CreateIndex
CREATE INDEX "credit_allocations_lot_id_state_idx" ON "credit_allocations"("lot_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "credit_allocations_hold_id_lot_id_key" ON "credit_allocations"("hold_id", "lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_refunds_refund_key_key" ON "credit_refunds"("refund_key");

-- CreateIndex
CREATE INDEX "credit_refunds_hold_id_idx" ON "credit_refunds"("hold_id");

-- CreateIndex
CREATE INDEX "credit_refunds_lot_id_mode_idx" ON "credit_refunds"("lot_id", "mode");

-- AddForeignKey
ALTER TABLE "funding_account_admins" ADD CONSTRAINT "funding_account_admins_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "funding_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_programs" ADD CONSTRAINT "grant_programs_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "credit_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "grant_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_funding_account_id_fkey" FOREIGN KEY ("funding_account_id") REFERENCES "funding_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_recipients" ADD CONSTRAINT "grant_recipients_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "grant_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_funding_account_id_fkey" FOREIGN KEY ("funding_account_id") REFERENCES "funding_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "credit_holds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "credit_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The words each column may hold. The code checks them first; the database is the last word.
ALTER TABLE "credit_categories" ADD CONSTRAINT "credit_categories_benefit_check" CHECK (("benefit" = 'reply' AND "unit" = 'reply') OR ("benefit" = 'money' AND "unit" = 'usd_micros'));
ALTER TABLE "credit_categories" ADD CONSTRAINT "credit_categories_status_check" CHECK ("status" IN ('active', 'retired'));

ALTER TABLE "funding_accounts" ADD CONSTRAINT "funding_accounts_kind_check" CHECK ("kind" IN ('platform', 'person', 'universe'));
ALTER TABLE "funding_accounts" ADD CONSTRAINT "funding_accounts_status_check" CHECK ("status" IN ('active', 'paused', 'closed'));
ALTER TABLE "funding_accounts" ADD CONSTRAINT "funding_accounts_owner_check" CHECK (("kind" = 'platform' AND "owner_key" = 'platform') OR ("kind" <> 'platform' AND "owner_key" <> 'platform'));
ALTER TABLE "funding_accounts" ADD CONSTRAINT "funding_accounts_budget_check" CHECK ("budget_micros" IS NULL OR "budget_micros" >= 0);

ALTER TABLE "grant_programs" ADD CONSTRAINT "grant_programs_kind_check" CHECK ("kind" IN ('default', 'exception', 'gift'));
ALTER TABLE "grant_programs" ADD CONSTRAINT "grant_programs_status_check" CHECK ("status" IN ('active', 'ended'));
-- One default program for a category at a time. Exceptions and gifts are many.
CREATE UNIQUE INDEX "grant_programs_one_default_idx" ON "grant_programs"("category_id") WHERE "kind" = 'default' AND "status" = 'active';

ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_state_check" CHECK ("state" IN ('current', 'superseded', 'ended'));
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_benefit_check" CHECK ("benefit_kind" IN ('replace', 'add_credit'));
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_schedule_check" CHECK ("schedule" IN ('once', 'monthly', 'none'));
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_share_check" CHECK ("share" IN ('each', 'shared'));
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_recipient_type_check" CHECK ("recipient_type" IN ('all', 'new_from', 'people', 'universe'));
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_settlement_check" CHECK ("settlement" IN ('free', 'to_bill'));
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_amount_check" CHECK ("amount" >= 0 AND ("schedule" <> 'none' OR "amount" = 0) AND ("schedule" = 'none' OR "amount" > 0));
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_covers_check" CHECK (cardinality("covers") >= 1);
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_claim_check" CHECK ("claim_ends_at" IS NULL OR "claim_ends_at" > "claim_starts_at");
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_new_from_check" CHECK ("recipient_type" <> 'new_from' OR ("recipient_from" IS NOT NULL AND ("recipient_to" IS NULL OR "recipient_to" > "recipient_from")));
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_universe_check" CHECK ("recipient_type" <> 'universe' OR ("recipient_universe_id" IS NOT NULL AND "recipient_mode" IN ('snapshot', 'changing')));
-- A changing group has an end, a cap on how many can join and a total funding cap
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_changing_check" CHECK ("recipient_mode" IS DISTINCT FROM 'changing' OR ("claim_ends_at" IS NOT NULL AND "joiner_cap" IS NOT NULL AND "joiner_cap" > 0 AND "total_cap_micros" IS NOT NULL AND "total_cap_micros" > 0));
-- An amount to be billed carries what was agreed
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_agreement_check" CHECK ("settlement" <> 'to_bill' OR "agreement_note" IS NOT NULL);
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_expiry_check" CHECK ("lot_expires_in_days" IS NULL OR "lot_expires_in_days" > 0);
ALTER TABLE "grant_rules" ADD CONSTRAINT "grant_rules_version_check" CHECK ("version" >= 1);
-- Only one current version of a program at a time
CREATE UNIQUE INDEX "grant_rules_one_current_idx" ON "grant_rules"("program_id") WHERE "state" = 'current';

ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_source_check" CHECK ("source" IN ('default', 'gift', 'manual_billing', 'purchase', 'replacement'));
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_unit_check" CHECK ("unit" = 'usd_micros');
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_amount_check" CHECK ("amount_micros" > 0);
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_covers_check" CHECK (cardinality("covers") >= 1);
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_settlement_check" CHECK ("settlement" IN ('free', 'to_bill'));
-- "Billed" can only be said of credit to be billed: free credit is never owed. Purchased credit is the only credit that is not free.
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_billed_check" CHECK ("billed_at" IS NULL OR "settlement" = 'to_bill');
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_manual_check" CHECK (("source" = 'manual_billing') = ("settlement" = 'to_bill') OR "source" = 'purchase');
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_subject_check" CHECK ("subject_key" LIKE 'person:%' OR "subject_key" LIKE 'pool:%');
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_person_check" CHECK (("subject_key" LIKE 'person:%' AND "person_id" IS NOT NULL) OR ("subject_key" LIKE 'pool:%' AND "person_id" IS NULL));
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_dates_check" CHECK ("expires_at" IS NULL OR "expires_at" > "starts_at");

ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_state_check" CHECK ("state" IN ('held', 'settled', 'released'));
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_category_check" CHECK ("category" IN ('instant_apps', 'computers'));
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_amount_check" CHECK ("amount_micros" > 0);
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_customer_check" CHECK ("customer_micros" IS NULL OR ("customer_micros" >= 0 AND "customer_micros" <= "amount_micros"));
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_refund_check" CHECK ("refunded_micros" >= 0 AND "refunded_micros" <= COALESCE("customer_micros", 0));
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_provider_check" CHECK ("provider_cost_micros" IS NULL OR "provider_cost_micros" >= 0);
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_basis_check" CHECK ("provider_cost_basis" IS NULL OR "provider_cost_basis" IN ('measured', 'estimated', 'unknown'));
-- A settled hold has what it charged; one that is held or released has none
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_settled_check" CHECK (("state" = 'settled') = ("customer_micros" IS NOT NULL));

ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_state_check" CHECK ("state" IN ('held', 'settled', 'released'));
ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_amount_check" CHECK ("amount_micros" > 0 AND ("settled_micros" IS NULL OR ("settled_micros" >= 0 AND "settled_micros" <= "amount_micros")));
ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_settled_check" CHECK (("state" = 'settled') = ("settled_micros" IS NOT NULL));

ALTER TABLE "credit_refunds" ADD CONSTRAINT "credit_refunds_mode_check" CHECK ("mode" IN ('restored', 'replacement'));
ALTER TABLE "credit_refunds" ADD CONSTRAINT "credit_refunds_reason_check" CHECK ("reason" IN ('platform_failure', 'goodwill', 'redelivery'));
ALTER TABLE "credit_refunds" ADD CONSTRAINT "credit_refunds_amount_check" CHECK ("amount_micros" > 0);
ALTER TABLE "credit_refunds" ADD CONSTRAINT "credit_refunds_replacement_check" CHECK (("mode" = 'replacement') = ("replacement_lot_id" IS NOT NULL));

-- What exists from the start: the three categories, and the platform's own funding account. Data, not behaviour: no program, so no credit.
INSERT INTO "credit_categories" ("id", "label", "benefit", "unit", "pays") VALUES
  ('universe_ai', 'Universe AI', 'reply', 'reply', ARRAY[]::TEXT[]),
  ('instant_apps', 'Instant Apps', 'money', 'usd_micros', ARRAY['instant_run']),
  ('computers', 'Computers', 'money', 'usd_micros', ARRAY['computer_job', 'computer_model', 'computer_tool']);
INSERT INTO "funding_accounts" ("id", "kind", "owner_key", "name") VALUES ('funding-platform', 'platform', 'platform', 'BAWES Universe');
