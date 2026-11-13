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

/**
 * `mayReadRoomBots` for many people at once, in two queries however many there are: the ids of those who may.
 * For the room feed, which asks about everyone found in a room on each sync.
 */
export async function whoMayReadRoomBots(room: VisibleRoomRecord, userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const [viewers, memberships] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }),
    prisma.worldMember.findMany({ where: { worldId: room.world.id, userId: { in: ids } }, select: { userId: true } }),
  ]);
  const members = new Set(memberships.map((membership) => membership.userId));
  const allowed = new Set<string>();
  for (const viewer of viewers) {
    if (canSeeRoom(room, { id: viewer.id, isSuperAdmin: isSuperAdmin(viewer.email) }, new Set(members.has(viewer.id) ? [room.world.id] : []))) allowed.add(viewer.id);
  }
  // A person Orbit has no account for is seen as nobody: only a room open to everyone lets them in
  for (const id of ids) {
    if (!viewers.some((viewer) => viewer.id === id) && canSeeRoom(room, null, new Set())) allowed.add(id);
  }
  return allowed;
}
