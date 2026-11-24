-- A key's last good call (a refusal seen before it is old news) and a marker so cards that could not follow a change of sign-in are tried again
ALTER TABLE "app_connections" ADD COLUMN "last_worked_at" TIMESTAMP(3);
ALTER TABLE "app_connections" ADD COLUMN "notices_pending_at" TIMESTAMP(3);
ALTER TABLE "bot_mcp_servers" ADD COLUMN "notices_pending_at" TIMESTAMP(3);
