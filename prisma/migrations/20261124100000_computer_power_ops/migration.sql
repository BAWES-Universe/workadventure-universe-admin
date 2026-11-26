-- Post-0.5.0 patch 2, B (GPT's eighth note): a provider stop already sent can land after a replacement woke the same machine. Agent37 has no operation id, generation or idempotency key on stop or start, so the fence is Orbit's own.
-- Additive only: a new table, a nullable column, and a CHECK that allows one more word. A server of the version before this runs beside it unchanged (it records no power operation and so never waits for one).

-- Layer 1: every stop or sleep Orbit sends to a Brick's machine is written here BEFORE the call (in the same commit as its claim, where it has one). The sender beats `beat_at` while its call and the check after it run, and writes
-- `done_at` when both returned. A wake of the same machine is admitted only when no row of it is open: done, or with a beat older than the longest life a dead sender's last request can have.
CREATE TABLE IF NOT EXISTS "computer_power_ops" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "provider_ref" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "beat_at" TIMESTAMP(3) NOT NULL,
    "done_at" TIMESTAMP(3),
    CONSTRAINT "computer_power_ops_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "computer_power_ops_check" CHECK ("kind" IN ('stop', 'rest') AND "beat_at" >= "sent_at")
);
CREATE INDEX IF NOT EXISTS "computer_power_ops_open_idx" ON "computer_power_ops" ("provider_ref", "beat_at") WHERE "done_at" IS NULL;
CREATE INDEX IF NOT EXISTS "computer_power_ops_sent_idx" ON "computer_power_ops" ("sent_at");

-- Layer 2: the last moment the machine of a job's billed stretch was proved awake (the readiness that began the stretch counts as one). A renewal that finds the machine asleep ends the stretch here, never later.
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "awake_proved_at" TIMESTAMP(3);

-- Layer 2: a job whose machine was found asleep under it goes back in line through a pause of its own kind, `machine` (always back in line, never `paused`, never told; the job's own `paused_why` keeps its old CHECK).
ALTER TABLE "computer_job_pauses" DROP CONSTRAINT IF EXISTS "computer_job_pauses_check";
ALTER TABLE "computer_job_pauses" ADD CONSTRAINT "computer_job_pauses_check" CHECK ("why" IN ('person', 'allowance', 'rule', 'machine') AND "n" >= 1 AND "seconds" >= 0);

-- Layer 2: when only the seconds a machine was proved awake are priced (a stretch ended at its last proof, by a pause or by an ending), the price window ends at that proof. Both the room's settlement and the books read it, so a rate that changed after the proof never changes what the proved seconds cost. NULL = priced to the pause's `at` / the job's `ended_at`, as before.
ALTER TABLE "computer_job_pauses" ADD COLUMN IF NOT EXISTS "priced_until" TIMESTAMP(3);
ALTER TABLE "computer_jobs" ADD COLUMN IF NOT EXISTS "priced_until" TIMESTAMP(3);
