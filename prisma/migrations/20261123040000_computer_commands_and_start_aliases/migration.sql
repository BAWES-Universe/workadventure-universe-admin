-- GPT round 6, findings 1, 4 and 5 (Rule D, identity): every effect that can arrive twice or late carries the identity it was decided under.
-- Additive only: one new table, new columns (nullable or with a default) and two foreign keys. A server of the version before this runs beside it unchanged (it never reads them).

-- Finding 4. One row per control the person gave (a click on the panel, or one tool call of Brick's in one turn): the command's own id, what it was, a hash of what it asked, and what it came to.
-- The row is written in the transaction that applies the control, BEFORE its effect: the same id again returns the stored outcome and writes nothing (no second pause, time event, note number or
-- provider cancel). A note keeps the turn it was bound to (`turn_response_id`): only that turn is ever cancelled for it, and only by the request that kept it.
CREATE TABLE "computer_job_commands" (
    "command_id" UUID NOT NULL,
    "bot_id" TEXT NOT NULL,
    "job_id" TEXT,
    "person_id" TEXT NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "args_hash" VARCHAR(64) NOT NULL,
    "outcome" JSONB,
    "turn_response_id" VARCHAR(255),
    "stretch" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_job_commands_pkey" PRIMARY KEY ("command_id")
);
CREATE INDEX "computer_job_commands_job_id_idx" ON "computer_job_commands"("job_id");
CREATE INDEX "computer_job_commands_bot_id_created_at_idx" ON "computer_job_commands"("bot_id", "created_at");
ALTER TABLE "computer_job_commands" ADD CONSTRAINT "computer_job_commands_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_job_commands" ADD CONSTRAINT "computer_job_commands_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Finding 1. A start that was answered with ANOTHER start's job (`earlier`) keeps that answer durably: state `answered`, with the answering job (`job_id`), or, while that start has no job yet,
-- the attempt it waits for (`alias_attempt_id`). A retry under the same key is answered from this row before anything else, after the job was acknowledged, ended, or the game forgot its key.
-- An attempt bound to a job lives as long as that job (the foreign key below): it is never swept by age.
ALTER TABLE "computer_start_attempts" ADD COLUMN "alias_attempt_id" TEXT;
-- Attempts that name a job that is already gone (made and taken away again: controls not set up, a rule) are let go first, so the key can be added
DELETE FROM "computer_start_attempts" a WHERE a."job_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "computer_jobs" j WHERE j."id" = a."job_id");
ALTER TABLE "computer_start_attempts" ADD CONSTRAINT "computer_start_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_start_attempts" ADD CONSTRAINT "computer_start_attempts_alias_attempt_id_fkey" FOREIGN KEY ("alias_attempt_id") REFERENCES "computer_start_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "computer_start_attempts_job_id_idx" ON "computer_start_attempts"("job_id");
CREATE INDEX "computer_start_attempts_alias_attempt_id_idx" ON "computer_start_attempts"("alias_attempt_id");

-- Finding 5. What stopped a job the month or a limit paused: a model call (`call`, with the estimate that was refused) or the renewal of its room (`renewal`, with that room), the month it was
-- refused in and a digest of the person's own limits then. It carries on by itself only once that much fits again. Null on a pause of before this, and on the person's own pause.
ALTER TABLE "computer_job_pauses" ADD COLUMN "blocked_kind" VARCHAR(10);
ALTER TABLE "computer_job_pauses" ADD COLUMN "blocked_micros" BIGINT;
ALTER TABLE "computer_job_pauses" ADD COLUMN "blocked_month" VARCHAR(7);
ALTER TABLE "computer_job_pauses" ADD COLUMN "blocked_rule_rev" VARCHAR(64);

-- Finding 5. A job the month or a limit paused that was put back in line by itself and has not run yet: `carried_on` is told only in the write that sets it running, once (cleared there).
ALTER TABLE "computer_jobs" ADD COLUMN "carry_on_pending" BOOLEAN NOT NULL DEFAULT false;

-- Finding 5. The new thing Brick may say about such a job: `back_in_line` (more arrived and the pause is over, but the job waits in line). Said only to a reader that opts in to the kind.
ALTER TABLE "computer_job_tellings" DROP CONSTRAINT "computer_job_tellings_check";
ALTER TABLE "computer_job_tellings" ADD CONSTRAINT "computer_job_tellings_check" CHECK ("kind" IN ('paused', 'carried_on', 'can_carry_on', 'back_in_line') AND ("why" IS NULL OR "why" IN ('allowance', 'rule')) AND "seq" >= 1);
