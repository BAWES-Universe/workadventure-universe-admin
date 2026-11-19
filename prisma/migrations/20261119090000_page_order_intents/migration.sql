-- A purchase wish per tap (the host makes it), the buyer it belongs to, and a line for every move an order makes.
ALTER TABLE "app_page_orders" ADD COLUMN "intent_id" VARCHAR(64);
ALTER TABLE "app_page_orders" ADD COLUMN "buyer_key" VARCHAR(80);

-- One order per (page, buyer, wish). Rows with no wish or no buyer (a start from an older host) are never equal to each other here.
CREATE UNIQUE INDEX "app_page_orders_artifact_id_buyer_key_intent_id_key" ON "app_page_orders"("artifact_id", "buyer_key", "intent_id");
CREATE INDEX "app_page_orders_artifact_id_buyer_key_status_idx" ON "app_page_orders"("artifact_id", "buyer_key", "status");

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
