-- The sweep's long-wait pass asks, every run, for the orders the service has not had the last word about (reconciled = false) in a waiting status and due now.
-- Without an index that is a scan of every page order ever made. This index lets the database NARROW that candidate set by (reconciled, status, next_look_at); it does
-- not supply the sweep's order (the pass combines two statuses and sorts them together by next_look_at, then created_at, which neither scan direction of this index gives).
--
-- Built CONCURRENTLY so checkout and payment writes on app_page_orders are never blocked while it builds, and therefore the ONLY statement of this migration (the
-- concurrent form cannot run inside a transaction block, which a file with two statements would be).
CREATE INDEX CONCURRENTLY "app_page_orders_reconciled_status_next_look_at_idx" ON "app_page_orders"("reconciled", "status", "next_look_at");
