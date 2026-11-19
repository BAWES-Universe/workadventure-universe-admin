-- One id for each usage report, made by Orbit when the report arrives, so a report written twice after a lost commit answer is one row.
ALTER TABLE "bots_ai_usage" ADD COLUMN IF NOT EXISTS "report_key" VARCHAR(36);
CREATE UNIQUE INDEX IF NOT EXISTS "bots_ai_usage_report_key_key" ON "bots_ai_usage"("report_key");
