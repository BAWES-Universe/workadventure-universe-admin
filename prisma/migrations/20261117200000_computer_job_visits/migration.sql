-- R06: where a job's computer browsed (host and path only), for the owner to look at later. New table and one nullable column.
ALTER TABLE "computer_jobs" ADD COLUMN "visits_state" VARCHAR(8);

CREATE TABLE "computer_job_visits" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "kind" VARCHAR(5) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "by" VARCHAR(6) NOT NULL DEFAULT 'brick',
    "method" VARCHAR(8),
    "host" VARCHAR(255),
    "path" VARCHAR(300),
    "count" INTEGER NOT NULL DEFAULT 1,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "form" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "computer_job_visits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "computer_job_visits_job_id_at_idx" ON "computer_job_visits"("job_id", "at");

ALTER TABLE "computer_job_visits" ADD CONSTRAINT "computer_job_visits_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
