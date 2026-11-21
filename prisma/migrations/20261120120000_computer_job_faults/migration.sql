-- The game relay's record of what went wrong on a computer job's model calls, and the kept decision about giving a failed job back. Two new tables, nothing
-- existing is changed.
CREATE TABLE "computer_job_faults" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "turn" INTEGER,
    "call_id" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "source" VARCHAR(12) NOT NULL,
    "route" VARCHAR(120),
    "provider_status" INTEGER,
    "at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_job_faults_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_job_faults_job_id_call_id_key" ON "computer_job_faults"("job_id", "call_id");
CREATE INDEX "computer_job_faults_route_at_idx" ON "computer_job_faults"("route", "at");

ALTER TABLE "computer_job_faults" ADD CONSTRAINT "computer_job_faults_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "computer_give_back_decisions" (
    "job_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "state" VARCHAR(8) NOT NULL,
    "basis" VARCHAR(20) NOT NULL,
    "cause_hint" VARCHAR(10),
    "reason" VARCHAR(32),
    "route" VARCHAR(120),
    "judged_turns" INTEGER[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" VARCHAR(200),
    "alerted_at" TIMESTAMP(3),
    "delivered_late" BOOLEAN NOT NULL DEFAULT false,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "computer_give_back_decisions_pkey" PRIMARY KEY ("job_id")
);

CREATE INDEX "computer_give_back_decisions_state_next_attempt_at_idx" ON "computer_give_back_decisions"("state", "next_attempt_at");
