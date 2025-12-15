-- Drop the old unique constraint
DROP INDEX IF EXISTS "membership_invitations_world_id_invited_user_id_key";

-- Create a new unique constraint that includes status
-- This allows multiple invitations with different statuses but only one pending per world-user pair
CREATE UNIQUE INDEX "UniquePendingInvitation" ON "membership_invitations"("world_id", "invited_user_id", "status");
