-- A Brick's purge no longer guesses how long a provider's machine listing may be. It needs two facts that were not kept: when the Brick's computer record
-- was made (no machine of it is older than that), and whether a make ever failed in a way that may have left a machine nobody wrote down.
ALTER TABLE "brick_computers" ADD COLUMN "make_unsure_at" TIMESTAMP(3);
ALTER TABLE "brick_purges" ADD COLUMN "machine_since" TIMESTAMP(3);
ALTER TABLE "brick_purges" ADD COLUMN "make_unsure" BOOLEAN NOT NULL DEFAULT false;
