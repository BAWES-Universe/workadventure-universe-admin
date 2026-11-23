-- "Try again" carries on in the same agent conversation (piece 8). Additive only: an index and a link on the column migration 192 added (`continues_job_id`, null for every job
-- of before this), so a server of the version before this runs beside it unchanged.
-- ONE continuation per ended job, ever: a second ask to carry on the same job (a redelivered "try again", two at once) finds the job the first made and never makes another.
CREATE UNIQUE INDEX "computer_jobs_continues_job_id_key" ON "computer_jobs"("continues_job_id");

-- The job carried on from must exist when the link is made; a job removed later (its Brick purged takes both) leaves the continuation standing with no link.
ALTER TABLE "computer_jobs" ADD CONSTRAINT "computer_jobs_continues_job_id_fkey" FOREIGN KEY ("continues_job_id") REFERENCES "computer_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
