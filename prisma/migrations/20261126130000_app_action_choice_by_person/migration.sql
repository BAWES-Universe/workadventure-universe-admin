-- Whether an App action's own choice (bot_mcp_tools.setting) is one a person made, or one Universe started the action on (lib/github/actions.ts:
-- Run a workflow asks first). Universe's starting choice follows the action's heading as the person changes it; a person's choice never moves.
-- Every own choice saved before this was a person's (Universe started none), except Run a workflow's Asks first, which can only be Universe's start.
ALTER TABLE "bot_mcp_tools" ADD COLUMN "setting_by_person" BOOLEAN NOT NULL DEFAULT false;
UPDATE "bot_mcp_tools" SET "setting_by_person" = true WHERE "setting" IS NOT NULL AND NOT ("name" = 'github_run_workflow' AND "setting" = 'asksFirst');
