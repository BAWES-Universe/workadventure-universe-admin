-- AlterTable: Add headers JSON column to bot_mcp_servers
ALTER TABLE "bot_mcp_servers" ADD COLUMN "headers" JSONB;
