-- A give-back the books never confirmed and that was let go of after the wait is kept, marked, instead of deleted: if the books did make it, a later look finds the row and records their amount
ALTER TABLE "instant_refunds" ADD COLUMN IF NOT EXISTS "released_at" TIMESTAMP(3);
