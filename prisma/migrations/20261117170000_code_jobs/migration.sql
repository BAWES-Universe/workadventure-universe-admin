-- Code jobs for Apps: the bounded replacement for the provider's code sandbox being on in every App session.

CREATE TABLE "code_jobs" (
    "id" TEXT NOT NULL,
    "job_key" VARCHAR(255) NOT NULL,
    "bot_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "state" VARCHAR(12) NOT NULL,
    "reason" VARCHAR(40),
    "capabilities" JSONB NOT NULL,
    "limits" JSONB NOT NULL,
    "reserved_micros" BIGINT NOT NULL,
    "settled_micros" BIGINT,
    "code_hash" VARCHAR(64) NOT NULL,
    "steps" INTEGER NOT NULL,
    "cells_run" INTEGER NOT NULL DEFAULT 0,
    "provider_user_id" VARCHAR(120) NOT NULL,
    "provider_session_id" VARCHAR(120),
    "provider_state" VARCHAR(8) NOT NULL DEFAULT 'none',
    "nested_calls" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "metered_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "code_jobs_job_key_key" ON "code_jobs"("job_key");
CREATE INDEX "code_jobs_state_deadline_at_idx" ON "code_jobs"("state", "deadline_at");
CREATE INDEX "code_jobs_provider_state_created_at_idx" ON "code_jobs"("provider_state", "created_at");
CREATE INDEX "code_jobs_person_id_created_at_idx" ON "code_jobs"("person_id", "created_at");
CREATE INDEX "code_jobs_expires_at_idx" ON "code_jobs"("expires_at");
CREATE INDEX "code_jobs_state_metered_at_idx" ON "code_jobs"("state", "metered_at");

ALTER TABLE "code_jobs" ADD CONSTRAINT "code_jobs_state_check" CHECK ("state" IN ('starting', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'));
ALTER TABLE "code_jobs" ADD CONSTRAINT "code_jobs_provider_state_check" CHECK ("provider_state" IN ('none', 'open', 'closed', 'unknown'));
ALTER TABLE "code_jobs" ADD CONSTRAINT "code_jobs_money_check" CHECK ("reserved_micros" >= 0 AND ("settled_micros" IS NULL OR "settled_micros" >= 0));

CREATE TABLE "owned_results" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "source_kind" VARCHAR(20) NOT NULL,
    "source_id" VARCHAR(255) NOT NULL,
    "maker_bot_id" VARCHAR(255) NOT NULL,
    "maker_name" VARCHAR(100) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "content_type" VARCHAR(120) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "access" VARCHAR(10) NOT NULL DEFAULT 'owner',
    "artifact_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owned_results_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "owned_results_access_check" CHECK ("access" = 'owner'),
    CONSTRAINT "owned_results_size_check" CHECK ("size_bytes" >= 0)
);

CREATE UNIQUE INDEX "owned_results_storage_key_key" ON "owned_results"("storage_key");
CREATE UNIQUE INDEX "owned_results_source_kind_source_id_name_key" ON "owned_results"("source_kind", "source_id", "name");
CREATE INDEX "owned_results_owner_id_created_at_idx" ON "owned_results"("owner_id", "created_at");
CREATE INDEX "owned_results_source_kind_source_id_idx" ON "owned_results"("source_kind", "source_id");

-- Launch Limits for code jobs, so they work on a fresh deploy ("on by default"). Seeded like the other launch Limits: a value already
-- saved always wins, it runs once (a value a super admin empties later stays empty), and none of it is enforced by code: these are only
-- the values the Limits screen starts with. Money is in millionths of a dollar.
--   maxSeconds            300       a whole job gets 5 minutes, then its workspace is deleted
--   maxCells              5         runs of code in one job (the provider stops any one run at 3 minutes)
--   maxCodeBytes          65536     64 KB of code in one run
--   maxInputBytes         10485760  10 MB of data put in the workspace (data passed in and data read from the App)
--   maxOutputBytes        26214400  25 MB of files kept from one job
--   maxOutputFiles        10        files kept from one job
--   maxResultChars        20000     characters of printed output sent back
--   maxReads              3         App reads Orbit may do for one job
--   atOncePerPerson       1         one job at a time for each person
--   atOnceAll             3         three jobs at once in all
--   jobsPerPersonPerDay   20        jobs a person may start in a day
--   exposureCeilingMicros 1000000   $1.00 a month the provider's sandbox may cost us (it costs nothing today; this holds if it starts)
--   keepDays              30        days a job's printed result is kept (its files stay until their owner deletes them)
--   maxKeptBytesPerPerson 1073741824 1 GB of result files one person may keep
--   waitSeconds           40        how long asking for the result waits (the bot server gives up on a call at 60 seconds)
--   maxAnswerBytes        204800    200 KB: the largest App answer handed to a Brick whole (bigger ones are not cut: the Brick is told and a code job can read all of it)
INSERT INTO "app_settings" ("key", "value", "updated_at")
VALUES (
  'code-job-limits',
  '{"maxSeconds":300,"maxCells":5,"maxCodeBytes":65536,"maxInputBytes":10485760,"maxOutputBytes":26214400,"maxOutputFiles":10,"maxResultChars":20000,"maxReads":3,"atOncePerPerson":1,"atOnceAll":3,"jobsPerPersonPerDay":20,"exposureCeilingMicros":1000000,"keepDays":30,"waitSeconds":40,"maxAnswerBytes":204800,"maxKeptBytesPerPerson":1073741824}'::jsonb,
  now()
)
ON CONFLICT ("key") DO UPDATE SET "value" = CASE
  WHEN jsonb_typeof("app_settings"."value") = 'object' THEN EXCLUDED."value" || "app_settings"."value"
  ELSE "app_settings"."value"
END;
