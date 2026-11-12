-- Goals and tasks (game #2002, Brick 11). Universe's own scheduler: a reminder, a schedule, a watch or a goal a person gave
-- their Brick, and one row per run. The unique (item_id, due_at) is what makes a run happen once. Nothing is written for
-- anyone here: an account that never asks for one has no rows.

-- CreateTable
CREATE TABLE "brick_items" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "words" TEXT NOT NULL,
    "condition" TEXT,
    "outcome" TEXT,
    "cadence" JSONB NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL,
    "next_due_at" TIMESTAMP(3),
    "waiting_for" VARCHAR(300),
    "status_line" VARCHAR(300),
    "steps" JSONB NOT NULL DEFAULT '[]',
    "state" VARCHAR(10) NOT NULL DEFAULT 'on',
    "set_by" VARCHAR(5) NOT NULL DEFAULT 'you',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "parent_id" TEXT,
    "paused_by" VARCHAR(14),
    "result" VARCHAR(1000),
    "done_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "failures_in_row" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brick_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brick_item_runs" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "fresh" BOOLEAN NOT NULL DEFAULT false,
    "state" VARCHAR(8) NOT NULL DEFAULT 'claimed',
    "outcome" VARCHAR(10),
    "result" VARCHAR(1000),
    "error" VARCHAR(300),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "brick_item_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brick_items_owner_id_state_idx" ON "brick_items"("owner_id", "state");

-- CreateIndex
CREATE INDEX "brick_items_bot_id_idx" ON "brick_items"("bot_id");

-- CreateIndex
CREATE INDEX "brick_items_state_next_due_at_idx" ON "brick_items"("state", "next_due_at");

-- CreateIndex
CREATE INDEX "brick_items_parent_id_idx" ON "brick_items"("parent_id");

-- CreateIndex
CREATE INDEX "brick_item_runs_item_id_claimed_at_idx" ON "brick_item_runs"("item_id", "claimed_at");

-- CreateIndex
CREATE INDEX "brick_item_runs_state_lease_until_idx" ON "brick_item_runs"("state", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "brick_item_runs_item_id_due_at_key" ON "brick_item_runs"("item_id", "due_at");

-- AddForeignKey
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "brick_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brick_item_runs" ADD CONSTRAINT "brick_item_runs_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "brick_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The database keeps the words the code relies on
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_kind_check" CHECK ("kind" IN ('reminder', 'schedule', 'watch', 'goal'));
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_state_check" CHECK ("state" IN ('on', 'paused', 'done', 'deleted'));
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_set_by_check" CHECK ("set_by" IN ('you', 'brick'));
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_paused_by_check" CHECK ("paused_by" IS NULL OR "paused_by" IN ('owner', 'brick_deleted'));
-- Only something that is on is ever due
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_due_only_when_on" CHECK ("state" = 'on' OR "next_due_at" IS NULL);
ALTER TABLE "brick_item_runs" ADD CONSTRAINT "brick_item_runs_state_check" CHECK ("state" IN ('claimed', 'done', 'failed', 'dropped'));
