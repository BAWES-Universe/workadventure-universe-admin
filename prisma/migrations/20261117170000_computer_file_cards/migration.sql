-- The file card: the files a finished computer job made reach the person's chat as downloadable cards.
--
-- `computer_job_files` has one row for each file handed over. The bytes are kept encrypted in the bucket under `storage_key` only until they reach the
-- chat, the Brick is deleted, or the days set in Limits pass; then `storage_key` is emptied and the row stays (name, path, time: never the bytes) so
-- the same file is never handed over twice. A finished job's message already waits for its ending to be closed (`end_closed_at`), and the files are handed over
-- before that, so nothing else is needed to keep the message from going without its cards. Nothing is written for anyone by this migration.

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

-- While a finished job's files are being handed over, its machine is not put to rest.
ALTER TABLE "brick_computers" ADD COLUMN "files_claimed_at" TIMESTAMP(3);
