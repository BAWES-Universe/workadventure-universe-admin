import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionData, getSessionId } from '@/lib/auth-token';
import { isSuperAdmin } from '@/lib/super-admin';
import { NOT_SYSTEM_USER, hiddenSystemOwnerId, notSystemRoom, notSystemUniverse, notSystemWorld, startRoomPath } from '@/lib/system-user';

export const runtime = 'nodejs';

/**
 * GET /api/admin/bootstrap - what the shell needs to start: who is signed in, the Universe's numbers, and the
 * person's own: the universes they own, the worlds they belong to, the rooms they starred, invitations waiting.
 */
export async function GET(request: NextRequest) {
  const sessionId = getSessionId(request);
  const session = sessionId ? await getSessionData(sessionId) : null;
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // Once the start room is elsewhere, System's spaces leave the counts. The built-in default space is always left out.
  const hidden = await hiddenSystemOwnerId();
  const [
    user,
    universes,
    worlds,
    rooms,
    users,
    defaultUniverse,
    defaultWorld,
    defaultRoom,
    myUniverses,
    myWorlds,
    myStars,
    myInvitations,
    myOwnedWorlds,
    myInvitationsSent,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, uuid: true, email: true, name: true },
    }),
    prisma.universe.count({ where: notSystemUniverse(hidden) }),
    prisma.world.count({ where: notSystemWorld(hidden) }),
    prisma.room.count({ where: notSystemRoom(hidden) }),
    prisma.user.count({ where: NOT_SYSTEM_USER }),
    // The default space, unless it is System's and the counts already leave it out.
    prisma.universe.findFirst({ where: { AND: [{ slug: 'default' }, notSystemUniverse(hidden)] }, select: { id: true } }),
    prisma.world.findFirst({
      where: { AND: [{ slug: 'default', universe: { slug: 'default' } }, notSystemWorld(hidden)] },
      select: { id: true },
    }),
    prisma.room.findFirst({
      where: { AND: [{ slug: 'default', world: { slug: 'default', universe: { slug: 'default' } } }, notSystemRoom(hidden)] },
      select: { id: true },
    }),
    prisma.universe.count({ where: { ownerId: session.userId } }),
    prisma.worldMember.count({ where: { userId: session.userId, world: notSystemWorld(hidden) } }),
    prisma.favorite.count({ where: { userId: session.userId, roomId: { not: null }, ...(hidden ? { room: notSystemRoom(hidden) } : {}) } }),
    prisma.membershipInvitation.count({ where: { invitedUserId: session.userId, status: 'pending' } }),
    // For You's first steps: worlds in universes you own, and invitations you've sent (any answer).
    prisma.world.count({ where: { universe: { ownerId: session.userId } } }),
    prisma.membershipInvitation.count({ where: { invitedByUserId: session.userId } }),
  ]);
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const response = NextResponse.json({
    version: 1,
    user: { ...user, tags: session.tags, isSuperAdmin: isSuperAdmin(user.email) },
    stats: {
      universes: Math.max(0, universes - (defaultUniverse ? 1 : 0)),
      worlds: Math.max(0, worlds - (defaultWorld ? 1 : 0)),
      rooms: Math.max(0, rooms - (defaultRoom ? 1 : 0)),
      users,
    },
    // Where everyone lands, as `@/universe/world/room` (null when START_ROOM_URL is a map URL instead).
    startRoom: startRoomPath(),
    mine: {
      universes: myUniverses,
      worlds: myWorlds,
      stars: myStars,
      invitations: myInvitations,
      ownedWorlds: myOwnedWorlds,
      invitationsSent: myInvitationsSent,
    },
  });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
