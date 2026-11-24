-- GPT round 5 (E1-E6, S2): ONE owner per computer job, checked in the write that takes effect, and a start that exists before its job row.
-- Additive only. Every existing job has owner_epoch 0 ("never claimed"): a runner that does not say an epoch is accepted for it exactly as before, and none after a claim moved it.
ALTER TABLE "computer_jobs" ADD COLUMN "owner_epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "computer_jobs" ADD COLUMN "owner_run" VARCHAR(40);
ALTER TABLE "computer_jobs" ADD COLUMN "lease_version" INTEGER NOT NULL DEFAULT 0;

-- The epoch a model key was made under (null: a job nobody claimed).
ALTER TABLE "computer_job_tokens" ADD COLUMN "owner_epoch" INTEGER;

-- One start the person asked for, kept before its job row exists.
CREATE TABLE "computer_start_attempts" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "start_key" VARCHAR(64) NOT NULL,
    "state" VARCHAR(10) NOT NULL DEFAULT 'open',
    "job_id" TEXT,
    "beat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_start_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_start_attempts_bot_id_person_id_start_key_key" ON "computer_start_attempts"("bot_id", "person_id", "start_key");
CREATE INDEX "computer_start_attempts_bot_id_person_id_state_idx" ON "computer_start_attempts"("bot_id", "person_id", "state");
