-- A counter that moves up each time a sign-in starts, so a sign-in that finishes after a newer one began is refused
ALTER TABLE "app_connections" ADD COLUMN "sign_in_generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bot_mcp_servers" ADD COLUMN "sign_in_generation" INTEGER NOT NULL DEFAULT 0;
