CREATE TABLE "linear_sh_operations" (
  "id" TEXT NOT NULL, "request_key" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL, "connection_id" TEXT NOT NULL, "workspace_id" TEXT NOT NULL,
  "app_actor_id" TEXT NOT NULL, "subject" TEXT NOT NULL, "account_id" TEXT NOT NULL,
  "linear_user_id" TEXT NOT NULL, "conversation" TEXT NOT NULL, "interaction_id" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL, "payload" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "results" JSONB NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL, "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "linear_sh_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "linear_sh_operation_status" CHECK ("status" IN ('pending','consumed','complete','cancelled','superseded'))
);
CREATE UNIQUE INDEX "linear_sh_operations_request_key_key" ON "linear_sh_operations"("request_key");
CREATE INDEX "linear_sh_operations_bot_id_subject_conversation_status_idx" ON "linear_sh_operations"("bot_id","subject","conversation","status");
