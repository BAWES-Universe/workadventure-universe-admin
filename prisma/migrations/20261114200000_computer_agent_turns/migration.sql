-- The agent's conversation and running turn for a computer job, and when a working machine was last kept awake (game #2000).
ALTER TABLE "computer_jobs" ADD COLUMN "agent_session_id" VARCHAR(80);
ALTER TABLE "computer_jobs" ADD COLUMN "agent_response_id" VARCHAR(120);
ALTER TABLE "brick_computers" ADD COLUMN "kept_awake_at" TIMESTAMP(3);
