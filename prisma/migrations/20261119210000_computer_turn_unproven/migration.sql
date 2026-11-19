-- A job that ended with a first turn marked as sent and never named may leave that turn running on the machine: nothing starts there until the machine is proved asleep
ALTER TABLE "brick_computers" ADD COLUMN "turn_unproven_since" TIMESTAMP(3);
