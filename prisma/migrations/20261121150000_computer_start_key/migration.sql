-- The caller's own key for one start of a job: a start repeating a key finds the job that key made and never makes a second one, and "did my start reach Orbit" is read by this key alone. Many rows may have none.
ALTER TABLE "computer_jobs" ADD COLUMN "start_key" VARCHAR(64);

CREATE UNIQUE INDEX "computer_jobs_bot_id_person_id_start_key_key" ON "computer_jobs"("bot_id", "person_id", "start_key");

-- A start with a key that has begun and not yet saved its job: written before its first read, removed once the job exists. The look for "did this start reach Orbit" answers "in progress" while one is there.
CREATE TABLE "computer_start_marks" (
    "id" TEXT NOT NULL,
    "fence" VARCHAR(64) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_start_marks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "computer_start_marks_fence_started_at_idx" ON "computer_start_marks"("fence", "started_at");

CREATE INDEX "computer_start_marks_started_at_idx" ON "computer_start_marks"("started_at");
