-- Root-agent item 3A: the take-over fence's starting mark is held by Orbit, not by the computer (an agent with admin rights can rewrite a file on its own computer).
-- This boot's id, the kernel's clock reading (ticks since boot) when the computer was made ready, the computer's own parts (pid, start tick, kind) and the fingerprints
-- (sha256) of Agent37's command runner. New columns with no default: existing rows have no mark (a fence on such a row is not proved and stops the machine; the next wake takes the mark). Safe to run twice.
ALTER TABLE "brick_computers" ADD COLUMN IF NOT EXISTS "mark_boot_id" VARCHAR(36);
ALTER TABLE "brick_computers" ADD COLUMN IF NOT EXISTS "mark_ticks" BIGINT;
ALTER TABLE "brick_computers" ADD COLUMN IF NOT EXISTS "mark_parts" JSONB;
ALTER TABLE "brick_computers" ADD COLUMN IF NOT EXISTS "mark_runners" JSONB;
