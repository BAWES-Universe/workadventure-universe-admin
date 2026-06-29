-- AlterTable: Add lastTestedAt and lastTestResult columns to bot_mcp_servers
ALTER TABLE "bot_mcp_servers" ADD COLUMN "last_tested_at" TIMESTAMP(3);
ALTER TABLE "bot_mcp_servers" ADD COLUMN "last_test_result" JSONB;
