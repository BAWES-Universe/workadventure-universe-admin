-- Who was in the chat when a file was put there (game #1993), the sender included, by the ids the bot server names
-- people by. A reply other people read uses a file only when every one of them is in this list. A file from before
-- this has an empty list, so it stays with its person: nobody else was recorded as there.
ALTER TABLE "bot_files" ADD COLUMN "seen_by" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
