-- CreateTable
CREATE TABLE "room_accesses" (
    "id" TEXT NOT NULL,
    "user_uuid" TEXT,
    "user_id" TEXT,
    "ip_address" TEXT NOT NULL,
    "user_name" TEXT,
    "user_email" TEXT,
    "is_guest" BOOLEAN NOT NULL DEFAULT true,
    "is_authenticated" BOOLEAN NOT NULL DEFAULT false,
    "has_membership" BOOLEAN NOT NULL DEFAULT false,
    "membership_tags" TEXT[],
    "universe_id" TEXT NOT NULL,
    "world_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "universe_slug" TEXT NOT NULL,
    "world_slug" TEXT NOT NULL,
    "room_slug" TEXT NOT NULL,
    "play_uri" TEXT NOT NULL,
    "accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_accesses_universe_id_accessed_at_idx" ON "room_accesses"("universe_id", "accessed_at");

-- CreateIndex
CREATE INDEX "room_accesses_world_id_accessed_at_idx" ON "room_accesses"("world_id", "accessed_at");

-- CreateIndex
CREATE INDEX "room_accesses_room_id_accessed_at_idx" ON "room_accesses"("room_id", "accessed_at");

-- CreateIndex
CREATE INDEX "room_accesses_user_id_accessed_at_idx" ON "room_accesses"("user_id", "accessed_at");

-- CreateIndex
CREATE INDEX "room_accesses_ip_address_accessed_at_idx" ON "room_accesses"("ip_address", "accessed_at");

-- CreateIndex
CREATE INDEX "room_accesses_accessed_at_idx" ON "room_accesses"("accessed_at");

-- AddForeignKey
ALTER TABLE "room_accesses" ADD CONSTRAINT "room_accesses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_accesses" ADD CONSTRAINT "room_accesses_universe_id_fkey" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_accesses" ADD CONSTRAINT "room_accesses_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_accesses" ADD CONSTRAINT "room_accesses_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
