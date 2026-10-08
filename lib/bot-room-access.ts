import { prisma } from '@/lib/db';
import { canSeeRoom, type VisibleRoomRecord } from '@/lib/room-visibility';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * Whether a signed-in person may read the bots of a room that is not open to everyone: the people who may see the room
 * (its world's members, the universe owner and super admins). A pending invitation is not a membership. Rooms open to
 * everyone and the bot server's admin token are decided by the callers, before this.
 */
export async function mayReadRoomBots(room: VisibleRoomRecord, userId: string): Promise<boolean> {
  const [viewer, membership] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } }),
    prisma.worldMember.findUnique({
      where: { userId_worldId: { userId, worldId: room.world.id } },
      select: { worldId: true },
    }),
  ]);
  return canSeeRoom(
    room,
    viewer ? { id: viewer.id, isSuperAdmin: isSuperAdmin(viewer.email) } : null,
    new Set(membership ? [room.world.id] : []),
  );
}
