import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { accessDetailFor, canManageWorldMembers, forbiddenResponse, getViewer, unauthorizedResponse, viewerUserId } from '@/lib/access-scope';

export const dynamic = 'force-dynamic';

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
      select: { world: { select: { id: true, name: true, universe: { select: { ownerId: true } } } } },
    });
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isGuest: true } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    const worldId = room.world.id;
    const me = viewerUserId(viewer);
    const [member, invitation, canInvite] = await Promise.all([
      prisma.worldMember.findUnique({ where: { userId_worldId: { userId, worldId } }, select: { tags: true } }),
      prisma.membershipInvitation.findFirst({ where: { worldId, invitedUserId: userId, status: 'pending' }, select: { id: true } }),
      // Match the existing invitation POST: a session and owner/admin membership are required, even for super admins.
      me ? canManageWorldMembers(me, worldId) : false,
    ]);
    const owner = room.world.universe.ownerId === userId;
    return NextResponse.json({
      world: { id: worldId, name: room.world.name },
      status: user.isGuest ? 'guest' : owner ? 'owner' : member ? 'member' : invitation ? 'invited' : 'none',
      tags: member?.tags ?? [],
      canInvite: canInvite && !user.isGuest && !owner && !member && !invitation,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Error fetching room membership:', error);
    return NextResponse.json({ error: 'Failed to fetch membership' }, { status: 500 });
  }
}
