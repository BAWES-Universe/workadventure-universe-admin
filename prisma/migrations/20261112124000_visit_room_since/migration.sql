-- When the person's game saw them come into the room a visiting Brick is in (game #2005). A visit only moves to another
-- room on a sighting newer than this, so a late sync from a room the person has already left moves nothing. Empty for a
-- visit that has not moved yet: it moves on the first sighting, as it always did.
-- `room_client` is which page load of the game said so: times are only compared when the same one said both, because a second
-- device has a clock of its own.
ALTER TABLE "brick_visits" ADD COLUMN "room_since" TIMESTAMP(3);
ALTER TABLE "brick_visits" ADD COLUMN "room_client" VARCHAR(64);
