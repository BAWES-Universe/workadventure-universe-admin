-- CreateIndex
CREATE INDEX "room_accesses_user_uuid_accessed_at_idx" ON "room_accesses"("user_uuid", "accessed_at");
