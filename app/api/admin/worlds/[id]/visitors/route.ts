import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

// Helper function to check if user can manage world members
async function canManageWorldMembers(worldId: string, userId: string): Promise<boolean> {
  const world = await prisma.world.findUnique({
    where: { id: worldId },
    include: {
      universe: {
        select: { ownerId: true },
      },
      members: {
        where: {
          userId: userId,
          tags: { has: 'admin' },
        },
      },
    },
  });

  if (!world) return false;

  // Check if user is universe owner
  if (world.universe.ownerId === userId) return true;

  // Check if user is world admin
  if (world.members.length > 0) return true;

  return false;
}

// GET /api/admin/worlds/[id]/visitors - Get recent visitors to world
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: worldId } = await params;
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');

    // Check permissions
    const canManage = await canManageWorldMembers(worldId, sessionUser.id);
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Get recent visitors (users with User records) from RoomAccess
    // We include any user with a userId, regardless of isAuthenticated flag
    // because isAuthenticated only indicates if they had OIDC token at access time
    // Exclude the current user (can't invite yourself)
    const visitors = await prisma.roomAccess.findMany({
      where: {
        worldId: worldId,
        userId: { 
          not: null, // Only users with User records (can be invited)
        },
        NOT: {
          userId: sessionUser.id, // Exclude current user
        },
      },
      select: {
        userId: true,
        userName: true,
        userEmail: true,
        accessedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { accessedAt: 'desc' },
      take: limit * 2, // Get more to account for duplicates before grouping
    });

    // Group by userId and get most recent visit
    // Also filter out current user as a safety check
    const visitorMap = new Map<string, typeof visitors[0]>();
    for (const visitor of visitors) {
      if (visitor.userId && visitor.userId !== sessionUser.id) {
        const existing = visitorMap.get(visitor.userId);
        if (!existing || visitor.accessedAt > existing.accessedAt) {
          visitorMap.set(visitor.userId, visitor);
        }
      }
    }

    // Check which visitors are already members
    const userIds = Array.from(visitorMap.keys());
    const existingMembers = await prisma.worldMember.findMany({
      where: {
        worldId: worldId,
        userId: { in: userIds },
      },
      select: { userId: true },
    });

    const memberUserIds = new Set(existingMembers.map(m => m.userId));

    // Check which visitors have pending invitations
    const pendingInvitations = await prisma.membershipInvitation.findMany({
      where: {
        worldId: worldId,
        invitedUserId: { in: userIds },
        status: 'pending',
      },
      select: { invitedUserId: true },
    });

    const invitedUserIds = new Set(pendingInvitations.map(i => i.invitedUserId));

    // Format response
    const formattedVisitors = Array.from(visitorMap.values()).map(visitor => ({
      id: visitor.user?.id || visitor.userId!,
      name: visitor.user?.name || visitor.userName,
      email: visitor.user?.email || visitor.userEmail,
      lastVisited: visitor.accessedAt,
      isMember: visitor.userId ? memberUserIds.has(visitor.userId) : false,
      hasPendingInvitation: visitor.userId ? invitedUserIds.has(visitor.userId) : false,
    }));

    return NextResponse.json({ visitors: formattedVisitors });
  } catch (error) {
    console.error('Error fetching visitors:', error);
    return NextResponse.json(
      { error: 'Failed to fetch visitors' },
      { status: 500 }
    );
  }
}

