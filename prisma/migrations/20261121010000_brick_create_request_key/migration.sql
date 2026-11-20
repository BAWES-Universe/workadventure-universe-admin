-- New Brick (game "New Bricks per hour", default-brick design DB-T13) can carry a request key: the same key from the same
-- person is the same request, so a tap tried again after a dropped connection gives back the first Brick and makes no second
-- one. The key is optional, so every Brick made before, or without one, has none; the database allows many of those (a NULL
-- is never equal to another).
ALTER TABLE "bots" ADD COLUMN "create_request_key" VARCHAR(200);

CREATE UNIQUE INDEX "bots_owner_id_create_request_key_key" ON "bots"("owner_id", "create_request_key");
