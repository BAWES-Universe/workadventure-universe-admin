-- CreateIndex
CREATE INDEX IF NOT EXISTS "favorites_room_id_idx" ON "favorites"("room_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "favorites_world_id_idx" ON "favorites"("world_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "favorites_universe_id_idx" ON "favorites"("universe_id");

