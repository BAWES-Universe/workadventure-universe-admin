-- A run that was given up without a report (it never finished in time, every try) has no report to carry "tell the person". The notice is handed out by the due call
-- instead, and again after a while until the bot server confirms it: this is when it was last handed out. Nothing else changes.

-- AlterTable
ALTER TABLE "brick_items" ADD COLUMN     "failure_notice_at" TIMESTAMP(3);
