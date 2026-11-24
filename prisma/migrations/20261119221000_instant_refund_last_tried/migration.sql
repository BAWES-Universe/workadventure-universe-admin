-- The sweep asks the books about the never-asked and the longest-ago-asked give-backs first (a few that stay unreachable cannot fill every batch)
ALTER TABLE "instant_refunds" ADD COLUMN "last_tried_at" TIMESTAMP(3);
CREATE INDEX "instant_refunds_confirmed_at_last_tried_at_idx" ON "instant_refunds"("confirmed_at", "last_tried_at");
