-- The take-over fence's number for a job, and the short-lived keys a job's computer holds (digest only)
ALTER TABLE "computer_jobs" ADD COLUMN "control_generation" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "computer_job_tokens" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "scope" VARCHAR(12) NOT NULL,
    "generation" INTEGER NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_job_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_job_tokens_digest_key" ON "computer_job_tokens"("digest");
CREATE INDEX "computer_job_tokens_job_id_revoked_at_idx" ON "computer_job_tokens"("job_id", "revoked_at");

ALTER TABLE "computer_job_tokens" ADD CONSTRAINT "computer_job_tokens_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
