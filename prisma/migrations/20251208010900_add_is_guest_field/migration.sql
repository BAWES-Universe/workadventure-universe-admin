-- AlterTable
ALTER TABLE "users" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;

-- Update existing users: mark as guest if they have no email (likely guests)
UPDATE "users" SET "is_guest" = true WHERE "email" IS NULL;

