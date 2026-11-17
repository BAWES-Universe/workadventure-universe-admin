-- Where each App runs (Composio or Universe's own version), how App runs ended, and the App names people asked for that are not
-- there yet (spec "Paying for Apps", sections 21 and 22). Three new tables; nothing existing is changed. An App with no route row
-- runs on Composio, exactly as today.
-- CreateTable
CREATE TABLE "app_routes" (
    "app_key" VARCHAR(60) NOT NULL,
    "route" VARCHAR(10) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by_id" TEXT,

    CONSTRAINT "app_routes_pkey" PRIMARY KEY ("app_key")
);

-- CreateTable
CREATE TABLE "app_use_outcomes" (
    "event_id" VARCHAR(255) NOT NULL,
    "app_key" VARCHAR(60) NOT NULL,
    "provider" VARCHAR(10) NOT NULL,
    "outcome" VARCHAR(10) NOT NULL,
    "refunded_micros" BIGINT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_use_outcomes_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "app_asks" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "name_key" VARCHAR(60) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "person_key" VARCHAR(64) NOT NULL,
    "times" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "app_asks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_use_outcomes_app_key_recorded_at_idx" ON "app_use_outcomes"("app_key", "recorded_at");

-- CreateIndex
CREATE INDEX "app_use_outcomes_recorded_at_idx" ON "app_use_outcomes"("recorded_at");

-- CreateIndex
CREATE INDEX "app_asks_day_idx" ON "app_asks"("day");

-- CreateIndex
CREATE UNIQUE INDEX "app_asks_day_name_key_person_key_key" ON "app_asks"("day", "name_key", "person_key");

