-- Test fixture (never shipped): the failing migration, fixed: the required column gets a default for existing rows
CREATE TABLE "fixture_partial" ("id" INTEGER PRIMARY KEY);
ALTER TABLE "users" ADD COLUMN "fixture_required" TEXT NOT NULL DEFAULT 'filled';
