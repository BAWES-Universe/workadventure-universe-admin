-- A goodwill give-back the books never confirmed is kept (not deleted) when its wait is over: only its budget use is released
-- (released_at); the sweep asks about the least recently asked first (last_tried_at).
ALTER TABLE "instant_refunds" ADD COLUMN "released_at" TIMESTAMP(3), ADD COLUMN "last_tried_at" TIMESTAMP(3);
CREATE INDEX "instant_refunds_confirmed_at_last_tried_at_idx" ON "instant_refunds"("confirmed_at", "last_tried_at");
