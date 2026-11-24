-- One order per (page, buyer, wish). Rows with no wish or no buyer (a start from an older host) are never equal to each other here.
-- Alone in its migration and CONCURRENTLY: it cannot run inside a transaction, and it never blocks writes to the table while it builds.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "app_page_orders_artifact_id_buyer_key_intent_id_key" ON "app_page_orders"("artifact_id", "buyer_key", "intent_id");
