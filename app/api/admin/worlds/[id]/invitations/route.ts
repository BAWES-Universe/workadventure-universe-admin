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

// GET /api/admin/worlds/[id]/invitations - Get pending invitations for a world
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // Check permissions for management (but allow viewing for anyone)
    const canManage = await canManageWorldMembers(id, sessionUser.id);

    // If user can't manage, only show invitations sent to them
    const whereClause: any = {
      worldId: id,
      status: 'pending',
    };
    
    if (!canManage) {
      whereClause.invitedUserId = sessionUser.id;
    }

    const invitations = await prisma.membershipInvitation.findMany({
      where: whereClause,
      include: {
        invitedUser: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        invitedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { invitedAt: 'desc' },
    });

    return NextResponse.json({ 
      invitations,
      canManage,
    });
  } catch (error) {
    console.error('Error fetching world invitations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch invitations' },
      { status: 500 }
    );
  }
}

