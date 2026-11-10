-- Free greetings with a cooldown: a greeting a bot makes on its own is marked on its usage row, so it is never counted against the
-- person it greeted, and each bot remembers when it last greeted each person. Existing rows are ordinary replies (false).

-- AlterTable
ALTER TABLE "bots_ai_usage" ADD COLUMN "greeting" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "bot_greetings" (
    "bot_id" TEXT NOT NULL,
    "person_key" VARCHAR(300) NOT NULL,
    "greeted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_greetings_pkey" PRIMARY KEY ("bot_id","person_key")
);

-- AddForeignKey
ALTER TABLE "bot_greetings" ADD CONSTRAINT "bot_greetings_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
