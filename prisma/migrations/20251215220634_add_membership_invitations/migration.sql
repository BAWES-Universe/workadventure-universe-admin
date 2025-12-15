-- CreateTable
CREATE TABLE "membership_invitations" (
    "id" TEXT NOT NULL,
    "world_id" TEXT NOT NULL,
    "invited_user_id" TEXT NOT NULL,
    "invited_by_user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "tags" TEXT[],
    "message" TEXT,
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "membership_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "membership_invitations_world_id_invited_user_id_key" ON "membership_invitations"("world_id", "invited_user_id");

-- CreateIndex
CREATE INDEX "membership_invitations_world_id_idx" ON "membership_invitations"("world_id");

-- CreateIndex
CREATE INDEX "membership_invitations_invited_user_id_idx" ON "membership_invitations"("invited_user_id");

-- CreateIndex
CREATE INDEX "membership_invitations_invited_by_user_id_idx" ON "membership_invitations"("invited_by_user_id");

-- CreateIndex
CREATE INDEX "membership_invitations_status_idx" ON "membership_invitations"("status");

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

