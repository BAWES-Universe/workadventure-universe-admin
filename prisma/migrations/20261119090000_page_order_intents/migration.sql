-- A purchase wish per tap (the host makes it), the buyer it belongs to, and a line for every move an order makes.
ALTER TABLE "app_page_orders" ADD COLUMN "intent_id" VARCHAR(64);
ALTER TABLE "app_page_orders" ADD COLUMN "buyer_key" VARCHAR(80);
-- What the service is sent as the description, kept so a start carried on later sends exactly what the first one did.
ALTER TABLE "app_page_orders" ADD COLUMN "description" VARCHAR(200);

-- The two indexes are built in the next two migrations, one statement each and CONCURRENTLY, so a table with checkouts in flight is never
-- locked against writes while they build.

CREATE TABLE "app_page_order_events" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "from_status" VARCHAR(32),
    "to_status" VARCHAR(14) NOT NULL,
    "reason" VARCHAR(60) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_page_order_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "app_page_order_events_order_id_created_at_idx" ON "app_page_order_events"("order_id", "created_at");

ALTER TABLE "app_page_order_events" ADD CONSTRAINT "app_page_order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "app_page_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
