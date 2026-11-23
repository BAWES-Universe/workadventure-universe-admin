-- Round 8 (GPT's seventh note, blockers A and B). Additive only: every column is nullable or has a default, so a server of the version before this runs beside it unchanged.

-- B1: the wake ticket. Every write that sets a Brick's machine `waking` or `restoring` takes the next number; an external stop, and a late success, count only while the number they were given is still the Brick's.
ALTER TABLE "brick_computers" ADD COLUMN IF NOT EXISTS "wake_epoch" INTEGER NOT NULL DEFAULT 0;

-- A1: what a start that ended with no job answered, so a retry of its key (and a start that waited on it) is answered the same, for good.
ALTER TABLE "computer_start_attempts" ADD COLUMN IF NOT EXISTS "outcome" JSONB;

-- A2: when the key was issued (the person's consent), so a key older than the consent window is never accepted for a new start, even after its record was cleaned up.
ALTER TABLE "computer_start_attempts" ADD COLUMN IF NOT EXISTS "issued_at" TIMESTAMP(3);
