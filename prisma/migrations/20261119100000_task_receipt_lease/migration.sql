-- Receipts that always settle (0.5.0, money fixes O1). An open receipt is on a lease the bot server renews; one still running when it runs
-- out is ended by the sweep from the run records. `generation` keeps a stale close from ending a newer turn. `outcome` and `actions` say how
-- the task came to end and how each of its Instant actions did (worked or failed).
ALTER TABLE "task_receipts" ADD COLUMN "lease_until" TIMESTAMP(3);
ALTER TABLE "task_receipts" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "task_receipts" ADD COLUMN "outcome" VARCHAR(8);
ALTER TABLE "task_receipts" ADD COLUMN "actions" JSONB;
ALTER TABLE "task_receipts" ADD CONSTRAINT "task_receipts_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('done', 'partial', 'refunded'));
CREATE INDEX "task_receipts_state_lease_until_idx" ON "task_receipts"("state", "lease_until");

-- A receipt that is still running when this lands is a live task as far as anyone knows (the bot server may be minutes into it): it gets a
-- fresh lease from now, which the bot server's next open or renew extends, and which only runs out if the task really is gone. (Times here are UTC, as Prisma writes them.)
-- A computer's receipt has none: its job is its own record.
UPDATE "task_receipts" SET "lease_until" = timezone('UTC', now()) + interval '10 minutes' WHERE "state" = 'running' AND "category" IS DISTINCT FROM 'computer';
-- A receipt that already ended came to what its state says
UPDATE "task_receipts" SET "outcome" = "state" WHERE "state" IN ('done', 'refunded');
