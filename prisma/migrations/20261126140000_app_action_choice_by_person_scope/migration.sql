-- 20261126130000_app_action_choice_by_person left every row named github_run_workflow on Asks first as Universe's start. Only Universe's own GitHub
-- (app_connections.source = 'github', lib/github/actions.ts) starts that action on Asks first, so on any other App (a person's own App with a tool of the
-- same name) that choice was the person's: it is marked as theirs here. Rows on Universe's own GitHub keep what the first migration gave them.
UPDATE "bot_mcp_tools" AS t SET "setting_by_person" = true
WHERE t."setting_by_person" = false
  AND t."name" = 'github_run_workflow'
  AND t."setting" = 'asksFirst'
  AND NOT EXISTS (
    SELECT 1 FROM "bot_mcp_servers" AS s JOIN "app_connections" AS c ON c."id" = s."connection_id"
    WHERE s."id" = t."server_id" AND c."source" = 'github'
  );
