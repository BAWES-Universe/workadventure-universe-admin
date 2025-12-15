import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

// DELETE /api/memberships/my/world/[id] - Leave world
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: worldId } = await params;

    // Check if world exists and get universe owner
    const world = await prisma.world.findUnique({
      where: { id: worldId },
      include: {
        universe: {
          select: { ownerId: true },
        },
      },
    });

    if (!world) {
      return NextResponse.json({ error: 'World not found' }, { status: 404 });
    }

    // Prevent universe owner from leaving
    if (world.universe.ownerId === sessionUser.id) {
      return NextResponse.json(
        { error: 'Universe owners cannot leave worlds in their universes' },
        { status: 403 }
      );
    }

    // Check if user is a member
    const membership = await prisma.worldMember.findUnique({
      where: {
        userId_worldId: {
          userId: sessionUser.id,
          worldId: worldId,
        },
      },
    });

    if (!membership) {
      return NextResponse.json(
        { error: 'You are not a member of this world' },
        { status: 404 }
      );
    }

    // Remove membership
    await prisma.worldMember.delete({
      where: { id: membership.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error leaving world:', error);
    return NextResponse.json(
      { error: 'Failed to leave world' },
      { status: 500 }
    );
  }
}

