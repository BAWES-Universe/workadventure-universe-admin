-- Code jobs, second step: the meter line is written once (metered_at), the run that makes the folder for files is counted (prepared_runs), and the
-- files a job leaves become results their owner keeps (owned_results) instead of rows that go with the job. Nothing was kept in code_job_outputs
-- by a released version, so it is dropped.

ALTER TABLE "code_jobs" ADD COLUMN "prepared_runs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "code_jobs" ADD COLUMN "metered_at" TIMESTAMP(3);
CREATE INDEX "code_jobs_state_metered_at_idx" ON "code_jobs"("state", "metered_at");

DROP TABLE "code_job_outputs";

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

-- Two more launch Limits, seeded like the others: a value already saved (or emptied on purpose) always wins, and none is enforced by code.
--   keepDays              (now) days a job's printed result is kept; its files stay until their owner deletes them
--   maxKeptBytesPerPerson 1073741824 1 GB of result files one person may keep
--   maxAnswerBytes        204800    200 KB: the largest App answer handed to a Brick whole (bigger ones are not cut: the Brick is told)
UPDATE "app_settings"
SET "value" = '{"maxAnswerBytes":204800,"maxKeptBytesPerPerson":1073741824}'::jsonb || "value"
WHERE "key" = 'code-job-limits' AND jsonb_typeof("value") = 'object';
