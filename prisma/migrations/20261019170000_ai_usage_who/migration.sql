-- Who talked and whose key paid (#374, part 6): two new empty columns on usage rows. Existing rows keep NULL, which
-- means "not recorded" for the first and "the server's own provider" for the second, exactly what they were.

-- AlterTable
ALTER TABLE "bots_ai_usage" ADD COLUMN "talked_user_id" VARCHAR(255),
ADD COLUMN "key_owner_id" TEXT;
