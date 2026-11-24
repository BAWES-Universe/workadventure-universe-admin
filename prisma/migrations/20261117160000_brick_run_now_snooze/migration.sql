-- Run now and a snooze that moves one occurrence (game #2002, Brick 11).
--
-- Snooze: a repeating item keeps the place its recurrence comes next in `regular_due_at` while one occurrence is snoozed
-- (`snoozed_until`, which is then also `next_due_at`), so snoozing 08:00 to 08:10 on an hourly task still runs 09:00 after it. Nothing that
-- exists is changed: every row has neither.
ALTER TABLE "brick_items" ADD COLUMN "regular_due_at" TIMESTAMP(3),
  ADD COLUMN "snoozed_until" TIMESTAMP(3);
-- Only something that is on has a snoozed occurrence
ALTER TABLE "brick_items" ADD CONSTRAINT "brick_items_snooze_only_when_on" CHECK ("state" = 'on' OR ("regular_due_at" IS NULL AND "snoozed_until" IS NULL));

-- Run now: an extra run the owner asked for. It waits "queued" until the bot server is handed it (the same claim as a scheduled run: same
-- gates, same lease), and is marked `manual` so it never moves the item's next due time or ends a one-off. `request_key` is the owner's
-- tap, so asking twice finds the one run.
ALTER TABLE "brick_item_runs" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "request_key" VARCHAR(64);
ALTER TABLE "brick_item_runs" DROP CONSTRAINT "brick_item_runs_state_check";
ALTER TABLE "brick_item_runs" ADD CONSTRAINT "brick_item_runs_state_check" CHECK ("state" IN ('queued', 'claimed', 'done', 'failed', 'dropped'));
-- Only a run that was asked for has a key, and a key names one run of an item
ALTER TABLE "brick_item_runs" ADD CONSTRAINT "brick_item_runs_request_key_check" CHECK ("request_key" IS NULL OR "manual" = true);
-- A run waits "queued" only when it was asked for
ALTER TABLE "brick_item_runs" ADD CONSTRAINT "brick_item_runs_queued_check" CHECK ("state" <> 'queued' OR "manual" = true);
CREATE UNIQUE INDEX "brick_item_runs_item_id_request_key_key" ON "brick_item_runs"("item_id", "request_key") WHERE "request_key" IS NOT NULL;
-- Finding what waits to be handed out
CREATE INDEX "brick_item_runs_queued_idx" ON "brick_item_runs"("claimed_at") WHERE "state" = 'queued';
