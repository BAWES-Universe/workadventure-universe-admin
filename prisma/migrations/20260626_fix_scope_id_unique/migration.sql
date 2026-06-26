-- Fix schema drift: replace COALESCE-based unique index with a proper unique constraint
-- Prisma's @@unique([avatarSetId, scopeType, scopeId]) cannot match an expression index.
-- Since scope_id is now non-nullable with default '', a standard UNIQUE constraint works.

-- Drop the old COALESCE-based unique index
DROP INDEX IF EXISTS "avatar_set_scopes_avatarSetId_scopeType_scopeId_key";

-- Make scope_id non-nullable with a default (table is empty in all envs — no data migration needed)
ALTER TABLE "avatar_set_scopes"
  ALTER COLUMN "scope_id" SET DEFAULT '',
  ALTER COLUMN "scope_id" SET NOT NULL;

-- Add a proper unique constraint that Prisma recognizes
ALTER TABLE "avatar_set_scopes"
  ADD CONSTRAINT "avatar_set_scopes_avatarSetId_scopeType_scopeId_key"
  UNIQUE ("avatar_set_id", "scope_type", "scope_id");
