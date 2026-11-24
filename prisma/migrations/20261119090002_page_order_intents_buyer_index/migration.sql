-- Finds a buyer's orders for a page. Alone in its migration and CONCURRENTLY (see the one before).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "app_page_orders_artifact_id_buyer_key_status_idx" ON "app_page_orders"("artifact_id", "buyer_key", "status");
