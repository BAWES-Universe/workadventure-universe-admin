-- Set while a Brick's computer has its browser cleared after a job; a job that starts meanwhile waits for it
ALTER TABLE "brick_computers" ADD COLUMN "clean_claimed_at" TIMESTAMP(3);

-- A machine that must be put to sleep and is not yet proved asleep: nothing uses it, and every sweep tries again
ALTER TABLE "brick_computers" DROP CONSTRAINT "brick_computers_machine_check";
ALTER TABLE "brick_computers" ADD CONSTRAINT "brick_computers_machine_check" CHECK ("machine" IN ('none', 'waking', 'resting', 'working', 'cold', 'broken', 'restoring', 'stopped', 'stopping'));
