-- When the person's game saw them come into the room a visiting Brick is in (game #2005). A visit only moves to another
-- room on a sighting newer than this, so a late sync from a room the person has already left moves nothing. Empty for a
-- visit that has not moved yet: it moves on the first sighting, as it always did.
ALTER TABLE "brick_visits" ADD COLUMN "room_since" TIMESTAMP(3);
