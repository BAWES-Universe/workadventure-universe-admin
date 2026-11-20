-- When a copy of a Brick computer's home folder was first taken for deletion and its object was not deleted yet, so the team can read how long the oldest
-- deletion has waited (a bucket that is slow, or one that has stopped accepting deletes). The row goes with its object, so a row with this set is a
-- deletion still waiting.
ALTER TABLE "computer_archives" ADD COLUMN "deletion_since" TIMESTAMP(3);

-- Copies already waiting when this lands were taken for deletion at a time nobody wrote down: they count from now (UTC, as Prisma writes times), never
-- from the day the copy was made, which would call a copy that was replaced yesterday a month old.
UPDATE "computer_archives" SET "deletion_since" = timezone('UTC', now()) WHERE "state" = 'superseded';

-- CreateIndex
CREATE INDEX "computer_archives_deletion_since_idx" ON "computer_archives"("deletion_since");
