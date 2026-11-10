-- Free greetings: a greeting a bot makes on its own is marked on its usage row, so it is never counted against the person it
-- greeted. Existing rows are ordinary replies (false).

-- AlterTable
ALTER TABLE "bots_ai_usage" ADD COLUMN "greeting" BOOLEAN NOT NULL DEFAULT false;
