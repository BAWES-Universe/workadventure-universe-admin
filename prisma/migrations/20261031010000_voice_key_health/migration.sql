-- Voice key health (#749): whether a person's voice key is working, and when it was last tried while it wasn't.
--
-- Six new columns on voice_providers, empty for every row there is today (the server's own providers never use them).

-- AlterTable
ALTER TABLE "voice_providers" ADD COLUMN "down_since" TIMESTAMP(3),
ADD COLUMN "down_reason" VARCHAR(20),
ADD COLUMN "down_part" VARCHAR(12),
ADD COLUMN "failed_recognition" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failed_speech" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "health_checked_at" TIMESTAMP(3);
