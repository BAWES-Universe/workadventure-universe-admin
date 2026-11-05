-- A server with more tools than the bot server keeps (500): say so instead of cutting the list silently.
--
-- Additive. Nobody gains or loses anything: every server starts as "not cut", and nothing reads the new columns until the
-- bot server sends them when it saves a list. A bot server that does not send them leaves a server "not cut".

-- AlterTable
ALTER TABLE "bot_mcp_servers"
  ADD COLUMN "tools_cut" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tools_seen" INTEGER;
