import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { accessDetailFor, forbiddenResponse, getViewer, unauthorizedResponse } from '@/lib/access-scope';
import { accessFor, worldsAllowing } from '@/lib/role-access';

export const dynamic = 'force-dynamic';

async function mayInvite(user: { id: string }, universeId: string, worldId: string): Promise<boolean> {
  // As in the invitation route: the owner, or a role that invites in this world. Being a super admin adds nothing.
  const access = await accessFor(prisma, universeId, { id: user.id });
  if (!access) return false;
  const worlds = worldsAllowing(access, 'INVITE_AND_REMOVE');
  return worlds === 'all' || worlds.includes(worldId);
}

/** Current world membership, for a room's visitor card. Visit-time tags can be out of date. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) return unauthorizedResponse();
    const { id, userId } = await params;
    // The same people who may identify visitors may inspect their membership.
    if ((await accessDetailFor(viewer, { roomId: id })) === 'minimal') return forbiddenResponse();
    const room = await prisma.room.findUnique({
      where: { id },
      select: { world: { select: { id: true, name: true, universeId: true, universe: { select: { ownerId: true } } } } },
    });
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isGuest: true } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    const worldId = room.world.id;
    const universeId = room.world.universeId;
    const [member, inUniverse, invitation, canInvite] = await Promise.all([
      prisma.worldMember.findUnique({ where: { userId_worldId: { userId, worldId } }, select: { tags: true } }),
      prisma.universeMember.findUnique({ where: { universeId_userId: { universeId, userId } }, select: { id: true } }),
      // Any pending invitation into this universe, including one sent the old way to another of its worlds, as the
      // invitation POST refuses a second one
      prisma.membershipInvitation.findFirst({
        where: { OR: [{ worldId }, { universeId }, { world: { universeId } }], invitedUserId: userId, status: 'pending' },
        select: { id: true },
      }),
      // Match the invitation POST: a session, and Invite and remove people in this world (from a role or as the owner).
      viewer.kind === 'user' ? mayInvite(viewer.user, universeId, worldId) : false,
    ]);
    const owner = room.world.universe.ownerId === userId;
    return NextResponse.json({
      world: { id: worldId, name: room.world.name },
      universeId,
      status: user.isGuest ? 'guest' : owner ? 'owner' : member ? 'member' : invitation ? 'invited' : 'none',
      // In the universe, through other worlds: the card says they are not in this world, not that they are not in it at all
      inUniverse: !!inUniverse,
      tags: member?.tags ?? [],
      canInvite: canInvite && !user.isGuest && !owner && !member && !invitation,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Error fetching room membership:', error);
    return NextResponse.json({ error: 'Failed to fetch membership' }, { status: 500 });
  }
}
