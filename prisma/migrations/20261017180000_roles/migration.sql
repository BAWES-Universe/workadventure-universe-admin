-- Roles (#314), Release 1: one Roles list per universe, and joining a universe once.
--
-- Nobody gains or loses access: every tag someone has today becomes the same-named role, limited to exactly the worlds
-- where they have it, and everyone keeps a world_members row in exactly the worlds they are in today. The tags column
-- stays and stays filled (lib/roles.ts syncWorldMembers), so going back is a redeploy with no data loss.
-- The one change to tags is the decision of 17 Oct: everyone who joined is a Member, so `member` is added where a row
-- had only `admin` or `editor` (scripts/roles-migration-check.mjs lists every such row).
--
-- Members and invitations are locked first, so nothing written while this runs is missed. Everything runs in one
-- transaction.
BEGIN;

LOCK TABLE "world_members", "membership_invitations" IN SHARE ROW EXCLUSIVE MODE;

-- AlterTable
ALTER TABLE "membership_invitations" ADD COLUMN     "all_worlds" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "role_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "universe_id" TEXT,
ADD COLUMN     "world_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "universe_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#99AAB5',
    "badge" TEXT,
    "permissions" BIGINT NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "built_in" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "universe_members" (
    "id" TEXT NOT NULL,
    "universe_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "all_worlds" BOOLEAN NOT NULL DEFAULT false,
    "world_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "universe_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "universe_member_roles" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "all_worlds" BOOLEAN NOT NULL DEFAULT false,
    "world_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "universe_member_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_universe_id_key_key" ON "roles"("universe_id", "key");

-- CreateIndex
CREATE INDEX "universe_members_user_id_idx" ON "universe_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "universe_members_universe_id_user_id_key" ON "universe_members"("universe_id", "user_id");

-- CreateIndex
CREATE INDEX "universe_member_roles_role_id_idx" ON "universe_member_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "universe_member_roles_member_id_role_id_key" ON "universe_member_roles"("member_id", "role_id");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "universe_members" ADD CONSTRAINT "universe_members_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "universe_members" ADD CONSTRAINT "universe_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "universe_member_roles" ADD CONSTRAINT "universe_member_roles_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "universe_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "universe_member_roles" ADD CONSTRAINT "universe_member_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Built-in roles in every universe. Their keys are the tags the game and saved maps already know. Admin has every
-- permission but Administrator (bits 0-13 = 16383); Editor has what the editor tag allows today: create and edit worlds
-- and rooms, edit maps, manage bots (8416). Member and Everyone add nothing.
INSERT INTO "roles" ("id", "universe_id", "key", "name", "color", "permissions", "position", "built_in", "updated_at")
SELECT gen_random_uuid()::text, "u"."id", "b"."key", "b"."name", "b"."color", "b"."permissions", "b"."position", true, now()
FROM "universes" AS "u"
CROSS JOIN (VALUES
  ('admin', 'Admin', '#F87171', 16383, 1000000),
  ('editor', 'Editor', '#60A5FA', 8416, 2),
  ('member', 'Member', '#A78BFA', 0, 1),
  ('everyone', 'Everyone', '#A3A3B5', 0, 0)
) AS "b"("key", "name", "color", "permissions", "position");

-- Every other tag in use (typed in the map editor, or sent through the API) becomes a custom role with no permissions,
-- so map areas locked to that tag still match the same people.
WITH "typed" AS (
  SELECT DISTINCT "w"."universe_id", "t"."tag"
  FROM "world_members" AS "m"
  JOIN "worlds" AS "w" ON "w"."id" = "m"."world_id"
  CROSS JOIN LATERAL unnest("m"."tags") AS "t"("tag")
  UNION
  SELECT DISTINCT "w"."universe_id", "t"."tag"
  FROM "membership_invitations" AS "i"
  JOIN "worlds" AS "w" ON "w"."id" = "i"."world_id"
  CROSS JOIN LATERAL unnest("i"."tags") AS "t"("tag")
  WHERE "i"."status" = 'pending'
)
INSERT INTO "roles" ("id", "universe_id", "key", "name", "permissions", "position", "built_in", "updated_at")
SELECT gen_random_uuid()::text, "universe_id", "tag", "tag", 0,
  10 + row_number() OVER (PARTITION BY "universe_id" ORDER BY "tag" DESC), false, now()
FROM "typed"
WHERE "tag" NOT IN ('admin', 'editor', 'member', 'everyone');

-- One universe membership per person, as a Member in exactly the worlds they are in today.
INSERT INTO "universe_members" ("id", "universe_id", "user_id", "all_worlds", "world_ids", "joined_at")
SELECT gen_random_uuid()::text, "w"."universe_id", "m"."user_id", false,
  array_agg("m"."world_id" ORDER BY "m"."world_id"), min("m"."joined_at")
FROM "world_members" AS "m"
JOIN "worlds" AS "w" ON "w"."id" = "m"."world_id"
GROUP BY "w"."universe_id", "m"."user_id";

-- Each tag they have becomes that role, limited to the worlds where they have it.
INSERT INTO "universe_member_roles" ("id", "member_id", "role_id", "all_worlds", "world_ids")
SELECT gen_random_uuid()::text, "um"."id", "r"."id", false, array_agg(DISTINCT "m"."world_id")
FROM "world_members" AS "m"
JOIN "worlds" AS "w" ON "w"."id" = "m"."world_id"
CROSS JOIN LATERAL unnest("m"."tags") AS "t"("tag")
JOIN "universe_members" AS "um" ON "um"."universe_id" = "w"."universe_id" AND "um"."user_id" = "m"."user_id"
JOIN "roles" AS "r" ON "r"."universe_id" = "w"."universe_id" AND "r"."key" = "t"."tag"
WHERE "t"."tag" NOT IN ('member', 'everyone')
GROUP BY "um"."id", "r"."id";

-- Each world row now carries their roles there, highest first, then member: what lib/roles.ts writes from now on.
UPDATE "world_members" AS "m"
SET "tags" = ARRAY(
  SELECT "x"."key" FROM (
    SELECT "r"."key", "r"."position"
    FROM "worlds" AS "w"
    JOIN "universe_members" AS "um" ON "um"."universe_id" = "w"."universe_id" AND "um"."user_id" = "m"."user_id"
    JOIN "universe_member_roles" AS "a" ON "a"."member_id" = "um"."id"
    JOIN "roles" AS "r" ON "r"."id" = "a"."role_id"
    WHERE "w"."id" = "m"."world_id" AND ("a"."all_worlds" OR "m"."world_id" = ANY ("a"."world_ids"))
    UNION ALL
    SELECT 'member', -1
  ) AS "x"
  ORDER BY "x"."position" DESC, "x"."key"
);

-- Invitations name the universe, the roles their tags stand for, and the world they were sent from.
UPDATE "membership_invitations" AS "i"
SET "universe_id" = "w"."universe_id",
    "all_worlds" = false,
    "world_ids" = ARRAY["i"."world_id"],
    "role_ids" = ARRAY(
      SELECT "r"."id"
      FROM unnest("i"."tags") AS "t"("tag")
      JOIN "roles" AS "r" ON "r"."universe_id" = "w"."universe_id" AND "r"."key" = "t"."tag"
      WHERE "t"."tag" NOT IN ('member', 'everyone')
      ORDER BY "r"."position" DESC
    )
FROM "worlds" AS "w"
WHERE "w"."id" = "i"."world_id";

COMMIT;
