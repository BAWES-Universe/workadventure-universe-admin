import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { prisma } from '@/lib/db';

// POST /api/admin/rooms/[id]/favorite
// Toggle favorite status for the current user
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireSession(request);
    const { id } = await params;

    // Verify room exists and get world/universe info
    const room = await prisma.room.findUnique({
      where: { id },
      include: {
        world: {
          select: {
            id: true,
            universeId: true,
          },
        },
      },
    });

    if (!room) {
      return NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
    }

    // Check if favorite already exists
    const existingFavorite = await prisma.favorite.findFirst({
      where: {
        userId: user.id,
        roomId: id,
      },
    });

    let isStarred: boolean;
    
    if (existingFavorite) {
      // Unstar: delete the favorite
      await prisma.favorite.delete({
        where: { id: existingFavorite.id },
      });
      isStarred = false;
    } else {
      // Star: create the favorite with universeId and worldId populated
      await prisma.favorite.create({
        data: {
          userId: user.id,
          roomId: id,
          worldId: room.worldId,
          universeId: room.world.universeId,
        },
      });
      isStarred = true;
    }

    // Get updated star count
    const starCount = await prisma.favorite.count({
      where: {
        roomId: id,
      },
    });

    return NextResponse.json({
      isStarred,
      starCount,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error toggling favorite:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

