-- AlterTable: Add wam_url and authentication_mandatory to rooms
ALTER TABLE "rooms" ADD COLUMN "wam_url" TEXT;
ALTER TABLE "rooms" ADD COLUMN "authentication_mandatory" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Remove map_url and wam_url from worlds (maps are room-specific only)
ALTER TABLE "worlds" DROP COLUMN IF EXISTS "map_url";
ALTER TABLE "worlds" DROP COLUMN IF EXISTS "wam_url";

