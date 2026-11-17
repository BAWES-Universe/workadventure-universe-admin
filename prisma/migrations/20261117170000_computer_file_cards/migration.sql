-- The file card: the files a finished computer job made reach the person's chat as downloadable cards.
--
-- `computer_job_files` has one row for each file handed over. The bytes are kept encrypted in the bucket under `storage_key` only until they reach the
-- chat, the Brick is deleted, or the days set in Limits pass; then `storage_key` is emptied and the row stays (name, path, time: never the bytes) so
-- the same file is never handed over twice. `files_ready_at` is when a finished job's files were handed over, so its "done" message waits for the cards.
-- Every job that is already over is marked ready now, so nothing old waits.

ALTER TABLE "computer_jobs" ADD COLUMN "files_ready_at" TIMESTAMP(3);
UPDATE "computer_jobs" SET "files_ready_at" = COALESCE("ended_at", now()) WHERE "status" IN ('done', 'stopped', 'failed');

CREATE TABLE "computer_job_files" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "path" VARCHAR(400) NOT NULL,
    "modified_at" TIMESTAMP(3) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "storage_key" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "computer_job_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_job_files_bot_id_path_modified_at_key" ON "computer_job_files"("bot_id", "path", "modified_at");
CREATE INDEX "computer_job_files_job_id_idx" ON "computer_job_files"("job_id");
CREATE INDEX "computer_job_files_storage_key_created_at_idx" ON "computer_job_files"("storage_key", "created_at");

ALTER TABLE "computer_job_files" ADD CONSTRAINT "computer_job_files_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
