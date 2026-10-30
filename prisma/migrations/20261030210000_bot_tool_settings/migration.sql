-- Bot tool settings (#738): what each tool of a bot's MCP server is, what a bot does with it, and who confirmed it.
--
-- Nobody gains or loses anything: every server that exists today is marked legacy_text ("Not checked yet") and keeps
-- working in text as it does, and nothing reads the new columns until the bot server and the game do (game #1654, #1656).
-- New servers start with legacy_text off, so their tools wait to be confirmed.

-- AlterTable
ALTER TABLE "bot_mcp_servers"
  ADD COLUMN "legacy_text" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "look_up_setting" VARCHAR(20) NOT NULL DEFAULT 'rightAway',
  ADD COLUMN "make_setting" VARCHAR(20) NOT NULL DEFAULT 'rightAway',
  ADD COLUMN "change_setting" VARCHAR(20) NOT NULL DEFAULT 'asksFirst',
  ADD COLUMN "delete_send_setting" VARCHAR(20) NOT NULL DEFAULT 'asksFirst',
  ADD COLUMN "policy_revision" INTEGER NOT NULL DEFAULT 1;

-- The servers that exist today
UPDATE "bot_mcp_servers" SET "legacy_text" = true;

ALTER TABLE "bot_mcp_servers" ADD CONSTRAINT "bot_mcp_servers_settings" CHECK (
  "look_up_setting" IN ('rightAway', 'asksFirst', 'off')
  AND "make_setting" IN ('rightAway', 'asksFirst', 'off')
  AND "change_setting" IN ('rightAway', 'asksFirst', 'off')
  AND "delete_send_setting" IN ('rightAway', 'asksFirst', 'off')
);

-- AlterTable: per bot. Asks before making more than 3 / 5 / 10 (null = no limit), asks which way to go, and how long a
-- card waits for an answer.
ALTER TABLE "bots"
  ADD COLUMN "ask_before_making" INTEGER DEFAULT 5,
  ADD COLUMN "ask_which_way" VARCHAR(20) NOT NULL DEFAULT 'rarely',
  ADD COLUMN "card_wait_minutes" INTEGER NOT NULL DEFAULT 10;

ALTER TABLE "bots" ADD CONSTRAINT "bots_tool_settings" CHECK (
  ("ask_before_making" IS NULL OR "ask_before_making" IN (3, 5, 10))
  AND "ask_which_way" IN ('rarely', 'beforeBiggerJobs', 'never')
  AND "card_wait_minutes" IN (5, 10, 30)
);

-- CreateTable
CREATE TABLE "bot_mcp_tools" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255),
    "description" TEXT,
    "fingerprint" VARCHAR(128) NOT NULL,
    "suggested_heading" VARCHAR(20),
    "suggestion_source" VARCHAR(20),
    "heading" VARCHAR(20),
    "moved_by_id" TEXT,
    "confirmed_by_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_mcp_tools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_mcp_tools_server_id_name_key" ON "bot_mcp_tools"("server_id", "name");

-- AddForeignKey
ALTER TABLE "bot_mcp_tools" ADD CONSTRAINT "bot_mcp_tools_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "bot_mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_mcp_tools" ADD CONSTRAINT "bot_mcp_tools_moved_by_id_fkey" FOREIGN KEY ("moved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_mcp_tools" ADD CONSTRAINT "bot_mcp_tools_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A tool's heading, suggestion and where it came from are one of a few known words, and a confirmed tool always has a
-- heading.
ALTER TABLE "bot_mcp_tools" ADD CONSTRAINT "bot_mcp_tools_values" CHECK (
  ("heading" IS NULL OR "heading" IN ('looksUp', 'makesNew', 'changesThings', 'deletesOrSends'))
  AND ("suggested_heading" IS NULL OR "suggested_heading" IN ('looksUp', 'makesNew', 'changesThings', 'deletesOrSends'))
  AND ("suggestion_source" IS NULL OR "suggestion_source" IN ('server', 'description', 'builtIn'))
  AND ("confirmed_at" IS NULL OR "heading" IS NOT NULL)
);
