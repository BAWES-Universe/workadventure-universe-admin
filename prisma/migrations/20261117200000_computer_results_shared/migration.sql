-- A computer's files are the person's own results in the one place results are kept (owned_results, the same as a code job's). The computer job's row
-- becomes the delivery ledger: it keeps the path and time it handed a file over from (so the same file is never handed over twice) and when the chat took it,
-- and points to the result. The bytes are in the result, not here.
-- Nothing of this has been released: a file kept under the earlier layout (sealed for this table alone) is not moved, only no longer listed.
ALTER TABLE "computer_job_files" ADD COLUMN "result_id" TEXT;
DROP INDEX IF EXISTS "computer_job_files_storage_key_created_at_idx";
ALTER TABLE "computer_job_files" DROP COLUMN "storage_key", DROP COLUMN "purged_at";
CREATE UNIQUE INDEX "computer_job_files_result_id_key" ON "computer_job_files"("result_id");
-- The result going (the person deleted it, or the days in Limits passed) empties the pointer; the ledger row stays
ALTER TABLE "computer_job_files" ADD CONSTRAINT "computer_job_files_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "owned_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;
