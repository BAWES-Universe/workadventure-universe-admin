-- When a bot's tool sign-in expires (game #1819): what the bot server saw when it really used a tool server, who connected
-- it (the person told), and the data a notice with buttons needs.
--
-- Nothing changes for anyone yet: every column starts empty. A connection with no "connected by" tells the bot's maker.

-- AlterTable
ALTER TABLE "bot_mcp_servers"
  ADD COLUMN "sign_in_lost_at" TIMESTAMP(3),
  ADD COLUMN "sign_in_lost_status" INTEGER,
  ADD COLUMN "no_answer_at" TIMESTAMP(3),
  ADD COLUMN "reconnected_at" TIMESTAMP(3),
  ADD COLUMN "connected_by_id" TEXT;

ALTER TABLE "bot_mcp_servers"
  ADD CONSTRAINT "bot_mcp_servers_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "user_notices" ADD COLUMN "data" JSONB;
