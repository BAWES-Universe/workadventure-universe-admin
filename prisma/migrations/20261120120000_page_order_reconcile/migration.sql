-- A closed order, or one that could not be confirmed, may still have been paid: it is looked at again, slowly, with no end date, until the
-- service says the last word (paid, a final failed state, or a payment for something else). Three additive columns: two nullable, one with a
-- constant default (no table rewrite, nothing locked), so it is safe to run with checkouts in flight and on a populated database.
ALTER TABLE "app_page_orders" ADD COLUMN "last_read_at" TIMESTAMP(3);
ALTER TABLE "app_page_orders" ADD COLUMN "reconciled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_page_orders" ADD COLUMN "next_look_at" TIMESTAMP(3);
