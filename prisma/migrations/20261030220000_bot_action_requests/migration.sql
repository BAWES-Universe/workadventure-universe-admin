-- A saved record for each bot action that waits for a tap (#739). New tables only: nothing existing changes, and nothing
-- reads them until the bot server and the game do (game #1656).

-- CreateTable
CREATE TABLE "bot_action_requests" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "proposal_key" VARCHAR(200) NOT NULL,
    "requester_key" VARCHAR(400) NOT NULL,
    "conversation_key" VARCHAR(400) NOT NULL,
    "connection_ref" VARCHAR(200),
    "tool_name" VARCHAR(255) NOT NULL,
    "heading" VARCHAR(20) NOT NULL,
    "tool_fingerprint" VARCHAR(128) NOT NULL,
    "policy_revision" INTEGER NOT NULL,
    "arguments" TEXT NOT NULL,
    "arguments_digest" VARCHAR(64) NOT NULL,
    "remember_scope" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'waiting',
    "closed_reason" VARCHAR(20),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "review_expires_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "start_by" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_action_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_action_decisions" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "event" VARCHAR(24) NOT NULL,
    "actor_key" VARCHAR(400),
    "from_revision" INTEGER NOT NULL,
    "to_revision" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_action_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_action_attempts" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'claimed',
    "idempotency_key" VARCHAR(100) NOT NULL,
    "provider_request_id" VARCHAR(200),
    "outcome_class" VARCHAR(60),
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "bot_action_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_action_grants" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "requester_key" VARCHAR(400) NOT NULL,
    "conversation_key" VARCHAR(400) NOT NULL,
    "connection_ref" VARCHAR(200),
    "tool_name" VARCHAR(255) NOT NULL,
    "heading" VARCHAR(20) NOT NULL,
    "tool_fingerprint" VARCHAR(128) NOT NULL,
    "policy_revision" INTEGER NOT NULL,
    "scope" JSONB NOT NULL,
    "from_request_id" VARCHAR(100),
    "idle_minutes" INTEGER NOT NULL,
    "idle_expires_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" VARCHAR(40),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_action_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_action_requests_bot_id_proposal_key_key" ON "bot_action_requests"("bot_id", "proposal_key");
CREATE INDEX "bot_action_requests_bot_id_conversation_key_status_idx" ON "bot_action_requests"("bot_id", "conversation_key", "status");
CREATE INDEX "bot_action_requests_status_review_expires_at_idx" ON "bot_action_requests"("status", "review_expires_at");
CREATE INDEX "bot_action_decisions_request_id_idx" ON "bot_action_decisions"("request_id");
CREATE UNIQUE INDEX "bot_action_attempts_request_id_attempt_no_key" ON "bot_action_attempts"("request_id", "attempt_no");
CREATE INDEX "bot_action_grants_bot_id_requester_key_conversation_key_idx" ON "bot_action_grants"("bot_id", "requester_key", "conversation_key");

-- Only one attempt of a request may be in flight (claimed) at a time, whatever the code does.
CREATE UNIQUE INDEX "bot_action_attempts_one_claimed" ON "bot_action_attempts"("request_id") WHERE "state" = 'claimed';

-- AddForeignKey
ALTER TABLE "bot_action_requests" ADD CONSTRAINT "bot_action_requests_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_action_decisions" ADD CONSTRAINT "bot_action_decisions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "bot_action_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_action_attempts" ADD CONSTRAINT "bot_action_attempts_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "bot_action_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_action_grants" ADD CONSTRAINT "bot_action_grants_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Known words only. A request is closed exactly when it has a reason, and every finished state has a finish time.
ALTER TABLE "bot_action_requests" ADD CONSTRAINT "bot_action_requests_values" CHECK (
  "status" IN ('waiting', 'approved', 'running', 'done', 'failed', 'couldntConfirm', 'closed')
  AND "heading" IN ('looksUp', 'makesNew', 'changesThings', 'deletesOrSends')
  AND ("closed_reason" IS NULL OR "closed_reason" IN ('declined', 'superseded', 'expired', 'stale', 'cancelled', 'revoked'))
  AND (("status" = 'closed') = ("closed_reason" IS NOT NULL))
  AND ("status" NOT IN ('done', 'failed', 'closed') OR "finished_at" IS NOT NULL)
  AND ("status" NOT IN ('approved', 'running') OR "start_by" IS NOT NULL)
  AND "revision" >= 1
);

-- A remembered approval is never for deleting or sending.
ALTER TABLE "bot_action_grants" ADD CONSTRAINT "bot_action_grants_values" CHECK (
  "heading" IN ('looksUp', 'makesNew', 'changesThings')
  AND "idle_minutes" > 0
);

ALTER TABLE "bot_action_attempts" ADD CONSTRAINT "bot_action_attempts_state" CHECK (
  "state" IN ('claimed', 'succeeded', 'failed', 'notSent', 'uncertain')
);
