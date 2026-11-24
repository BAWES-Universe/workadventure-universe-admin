-- What a computer makes is the person's own: an owned record with its provenance, kept for the days in Limits or until they delete it, and it does not go
-- with the job, the machine or the Brick that made it (a deleted Brick leaves the person's files, under "A deleted Brick"). Only an account being deleted takes
-- its files with it.
ALTER TABLE "computer_job_files" ADD COLUMN "owner_id" TEXT,
ADD COLUMN "maker_name" VARCHAR(100),
ADD COLUMN "job_title" VARCHAR(200);

UPDATE "computer_job_files" f
SET "owner_id" = j."person_id", "job_title" = j."title", "maker_name" = COALESCE(b."name", 'Brick')
FROM "computer_jobs" j
LEFT JOIN "bots" b ON b."id" = j."bot_id"
WHERE j."id" = f."job_id";

-- A row whose job could not be found cannot say whose it is (none should exist: the job used to delete its files)
DELETE FROM "computer_job_files" WHERE "owner_id" IS NULL;

ALTER TABLE "computer_job_files" ALTER COLUMN "owner_id" SET NOT NULL,
ALTER COLUMN "maker_name" SET NOT NULL,
ALTER COLUMN "job_title" SET NOT NULL;

-- The job going no longer takes the file with it
ALTER TABLE "computer_job_files" DROP CONSTRAINT "computer_job_files_job_id_fkey";
ALTER TABLE "computer_job_files" ALTER COLUMN "job_id" DROP NOT NULL;
ALTER TABLE "computer_job_files" ADD CONSTRAINT "computer_job_files_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "computer_job_files" ADD CONSTRAINT "computer_job_files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "computer_job_files_owner_id_created_at_idx" ON "computer_job_files"("owner_id", "created_at");
