-- The runner's committed word that a computer job is to end, kept before the runner gives up, so a replacement runner (or the sweep) completes the finish and nothing else runs on the job meanwhile.
-- One row per job (the first one is kept), with what the finish will say; removed with the job. A new table, nothing existing is changed.
CREATE TABLE "computer_finish_intents" (
    "job_id" TEXT NOT NULL,
    "outcome" VARCHAR(6) NOT NULL,
    "cause" VARCHAR(8),
    "why" VARCHAR(2000),
    "turns" INTEGER[],
    "run" VARCHAR(40),
    "generation" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_finish_intents_pkey" PRIMARY KEY ("job_id")
);

CREATE INDEX "computer_finish_intents_created_at_idx" ON "computer_finish_intents"("created_at");

ALTER TABLE "computer_finish_intents" ADD CONSTRAINT "computer_finish_intents_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
