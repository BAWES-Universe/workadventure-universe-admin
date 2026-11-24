-- Out of the month's computer time, or over a spending limit the person set, PAUSES a job instead of ending it (piece 3 of the computer job controls).
-- Additive only: new columns (nullable or with a default) and one new table, so a server of the version before this runs beside it unchanged (it never reads them).

-- What Apps the Brick had when a job that held the machine was paused (a digest, never the Apps themselves): a job paused for its month or a limit carries on by itself
-- only while they are the same, otherwise Brick asks first. Null on a pause of before this (read as "unknown": Brick asks).
ALTER TABLE "computer_job_pauses" ADD COLUMN "grants_print" VARCHAR(64);
-- The month or a limit was reached while the person held the screen: the screen was taken back and the job paused (Fable's ruling of 23 Nov, section 7). Such a job never
-- carries on by itself (Brick asks first), and on resume it asks the person again for the step they were on.
ALTER TABLE "computer_job_pauses" ADD COLUMN "held_screen" BOOLEAN NOT NULL DEFAULT false;

-- What Brick is to tell the person about a job that the month or a limit paused, and about it carrying on (said once each, under its own key, like a report back).
CREATE TABLE "computer_job_tellings" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "why" VARCHAR(10),
    "held_screen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "told_at" TIMESTAMP(3),
    "undeliverable_at" TIMESTAMP(3),
    "stale_at" TIMESTAMP(3),

    CONSTRAINT "computer_job_tellings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "computer_job_tellings_job_id_seq_key" ON "computer_job_tellings"("job_id", "seq");
CREATE INDEX "computer_job_tellings_open_idx" ON "computer_job_tellings"("told_at", "undeliverable_at", "stale_at", "created_at");

ALTER TABLE "computer_job_tellings" ADD CONSTRAINT "computer_job_tellings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "computer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_job_tellings" ADD CONSTRAINT "computer_job_tellings_check" CHECK ("kind" IN ('paused', 'carried_on', 'can_carry_on') AND ("why" IS NULL OR "why" IN ('allowance', 'rule')) AND "seq" >= 1);
