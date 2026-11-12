-- Goals and tasks (game #2002): where a run's message went. Set once, right after the message is sent, so a run that is handed
-- out again can look here before it writes anything. Nothing is written for anyone by this migration.

-- AlterTable
ALTER TABLE "brick_item_runs" ADD COLUMN "delivered_event_id" VARCHAR(255),
ADD COLUMN "delivered_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "brick_items" ADD COLUMN "failure_told" BOOLEAN NOT NULL DEFAULT false;
