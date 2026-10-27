-- Where a bot reply was given and who it was for (Orbit #491, game #1159 step 6): three new empty columns on usage rows.
-- Existing rows keep NULL, which the bot page shows as "Not split" and as nobody in particular.

-- AlterTable
ALTER TABLE "bots_ai_usage" ADD COLUMN "channel" VARCHAR(10),
ADD COLUMN "talked_person_id" TEXT,
ADD COLUMN "talked_guest" BOOLEAN;

-- CreateIndex
CREATE INDEX "bots_ai_usage_talked_person_id_timestamp_idx" ON "bots_ai_usage"("talked_person_id", "timestamp");

-- CreateIndex
CREATE INDEX "bots_ai_usage_talked_user_id_timestamp_idx" ON "bots_ai_usage"("talked_user_id", "timestamp");

-- AddForeignKey
ALTER TABLE "bots_ai_usage" ADD CONSTRAINT "bots_ai_usage_talked_person_id_fkey" FOREIGN KEY ("talked_person_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
