-- Test fixture (never shipped): fails on a populated database. The first statement applies; the second is refused
-- by Postgres because "users" already has rows and the new column is required with no default.
CREATE TABLE "fixture_partial" ("id" INTEGER PRIMARY KEY);
ALTER TABLE "users" ADD COLUMN "fixture_required" TEXT NOT NULL;
