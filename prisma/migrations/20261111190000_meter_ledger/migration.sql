-- The meter's books (game #1998, Brick 7). Our own count of everything that costs money, recorded once under an event id,
-- against a person, a Brick and a payer, each figure marked measured, estimated, paid by someone else or unknown. It runs in
-- shadow first: nothing here changes what anyone can do today, and nothing that exists is touched or copied in. There are no
-- foreign keys on purpose: the books keep what happened after a person, a bot or a Brick is deleted.

-- CreateTable
CREATE TABLE "meter_events" (
    "id" TEXT NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "pool" VARCHAR(10) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "person_key" VARCHAR(320) NOT NULL,
    "person_id" TEXT,
    "bot_id" TEXT,
    "brick" BOOLEAN,
    "payer_kind" VARCHAR(10) NOT NULL,
    "payer_person_id" TEXT,
    "route" VARCHAR(40),
    "job_id" VARCHAR(255),
    "quantity" BIGINT NOT NULL,
    "unit" VARCHAR(12) NOT NULL,
    "cost_micros" BIGINT,
    "basis" VARCHAR(16) NOT NULL,
    "settled_at" TIMESTAMP(3),
    "source_ref" VARCHAR(255),
    "detail" JSONB,

    CONSTRAINT "meter_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_reservations" (
    "id" TEXT NOT NULL,
    "reservation_key" VARCHAR(255) NOT NULL,
    "person_key" VARCHAR(320) NOT NULL,
    "person_id" TEXT,
    "bot_id" TEXT,
    "job_id" VARCHAR(255),
    "amount_micros" BIGINT NOT NULL,
    "state" VARCHAR(10) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "renewals" INTEGER NOT NULL DEFAULT 0,
    "settled_micros" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "meter_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_grants" (
    "id" TEXT NOT NULL,
    "grant_key" VARCHAR(255) NOT NULL,
    "person_id" TEXT NOT NULL,
    "settlement" VARCHAR(10) NOT NULL,
    "multiplier" INTEGER,
    "no_limit" BOOLEAN NOT NULL DEFAULT false,
    "covers" VARCHAR(20) NOT NULL DEFAULT 'all',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "given_by_id" TEXT NOT NULL,
    "note" VARCHAR(1000),
    "billed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meter_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meter_events_event_id_key" ON "meter_events"("event_id");

-- CreateIndex
CREATE INDEX "meter_events_person_key_occurred_at_idx" ON "meter_events"("person_key", "occurred_at");

-- CreateIndex
CREATE INDEX "meter_events_bot_id_occurred_at_idx" ON "meter_events"("bot_id", "occurred_at");

-- CreateIndex
CREATE INDEX "meter_events_pool_kind_occurred_at_idx" ON "meter_events"("pool", "kind", "occurred_at");

-- CreateIndex
CREATE INDEX "meter_events_source_ref_idx" ON "meter_events"("source_ref");

-- CreateIndex
CREATE UNIQUE INDEX "meter_reservations_reservation_key_key" ON "meter_reservations"("reservation_key");

-- CreateIndex
CREATE INDEX "meter_reservations_person_key_state_idx" ON "meter_reservations"("person_key", "state");

-- CreateIndex
CREATE INDEX "meter_reservations_state_expires_at_idx" ON "meter_reservations"("state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "meter_grants_grant_key_key" ON "meter_grants"("grant_key");

-- CreateIndex
CREATE INDEX "meter_grants_person_id_ends_at_idx" ON "meter_grants"("person_id", "ends_at");


-- The words each column may hold. The code checks them first; the database is the last word, so a typo in a writer can
-- never put a figure in the books that no one can read.
ALTER TABLE "meter_events" ADD CONSTRAINT "meter_events_kind_check" CHECK ("kind" IN ('model_call', 'speech', 'app_use', 'computer_time', 'size_change', 'stored_bytes'));
ALTER TABLE "meter_events" ADD CONSTRAINT "meter_events_pool_check" CHECK ("pool" IN ('chat', 'computer'));
ALTER TABLE "meter_events" ADD CONSTRAINT "meter_events_payer_check" CHECK ("payer_kind" IN ('universe', 'person', 'unknown'));
ALTER TABLE "meter_events" ADD CONSTRAINT "meter_events_basis_check" CHECK ("basis" IN ('measured', 'estimated', 'paid_by_other', 'unknown'));
ALTER TABLE "meter_events" ADD CONSTRAINT "meter_events_person_key_check" CHECK ("person_key" = 'unknown' OR "person_key" LIKE 'person:%' OR "person_key" LIKE 'guest:%');
ALTER TABLE "meter_events" ADD CONSTRAINT "meter_events_amounts_check" CHECK ("quantity" >= 0 AND ("cost_micros" IS NULL OR "cost_micros" >= 0));

ALTER TABLE "meter_reservations" ADD CONSTRAINT "meter_reservations_state_check" CHECK ("state" IN ('held', 'settled', 'released'));
ALTER TABLE "meter_reservations" ADD CONSTRAINT "meter_reservations_amount_check" CHECK ("amount_micros" > 0);

-- A grant is a gift or extra usage to be billed; it is either a multiple (2 or more) or no limit, and it ends. "Billed" can
-- only be said of extra usage to be billed: a gift is never owed.
ALTER TABLE "meter_grants" ADD CONSTRAINT "meter_grants_settlement_check" CHECK ("settlement" IN ('gift', 'to_bill'));
ALTER TABLE "meter_grants" ADD CONSTRAINT "meter_grants_size_check" CHECK (("multiplier" IS NOT NULL AND "multiplier" >= 2 AND NOT "no_limit") OR ("multiplier" IS NULL AND "no_limit"));
ALTER TABLE "meter_grants" ADD CONSTRAINT "meter_grants_dates_check" CHECK ("ends_at" > "starts_at");
ALTER TABLE "meter_grants" ADD CONSTRAINT "meter_grants_billed_check" CHECK ("billed_at" IS NULL OR "settlement" = 'to_bill');
