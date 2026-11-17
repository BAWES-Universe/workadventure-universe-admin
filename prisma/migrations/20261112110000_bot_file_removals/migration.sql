-- A file a person deleted from a Brick's list (game #2003) waits here until the bot server has removed it from the
-- uploader and said so. Only where the file is is kept, never its name or its words. Nothing is written until someone
-- presses Delete on a file they sent.

-- CreateTable
CREATE TABLE "bot_file_removals" (
    "id" TEXT NOT NULL,
    "bot_id" VARCHAR(255) NOT NULL,
    "bucket" VARCHAR(255) NOT NULL,
    "file_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_file_removals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_file_removals_bucket_file_id_key" ON "bot_file_removals"("bucket", "file_id");

-- CreateIndex
CREATE INDEX "bot_file_removals_created_at_idx" ON "bot_file_removals"("created_at");
