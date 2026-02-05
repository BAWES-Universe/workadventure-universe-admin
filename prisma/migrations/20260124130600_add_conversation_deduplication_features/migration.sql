-- Add missing end_reason column to conversations table
ALTER TABLE "bots_conversations_recent" 
ADD COLUMN "end_reason" VARCHAR(50);

-- Add unique constraint for active conversations only
-- This prevents duplicate conversations for the same bot+user when ended_at = started_at
CREATE UNIQUE INDEX "idx_bot_user_active" 
ON "bots_conversations_recent" ("bot_id", "user_uuid") 
WHERE "ended_at" = "started_at";