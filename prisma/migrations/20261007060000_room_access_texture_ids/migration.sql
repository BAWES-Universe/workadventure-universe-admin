-- A guest's Woka, so Recent visitors and the Visitors list can show them as they look.
ALTER TABLE "room_accesses" ADD COLUMN     "texture_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
