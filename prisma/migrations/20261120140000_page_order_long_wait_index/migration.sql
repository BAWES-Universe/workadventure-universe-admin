-- The sweep's long-wait pass asks, every run, for the orders the service has not had the last word about (reconciled = false) in a waiting status, due now, oldest
-- schedule first. Without an index that is a scan of every page order ever made. One ordinary index in the order the query filters and sorts; it holds only
-- three small columns of a table that grows by one row per checkout, so it builds in moments and the table is not rewritten.
CREATE INDEX "app_page_orders_reconciled_status_next_look_at_idx" ON "app_page_orders"("reconciled", "status", "next_look_at");
