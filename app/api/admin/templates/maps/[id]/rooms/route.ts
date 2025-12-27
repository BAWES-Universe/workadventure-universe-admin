import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

// GET /api/admin/templates/maps/[id]/rooms
// Get all rooms using this template map (public endpoint)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Verify map exists
    const map = await prisma.roomTemplateMap.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });

    if (!map) {
      return NextResponse.json(
        { error: 'Map not found' },
        { status: 404 }
      );
    }

    // Get all public rooms using this template map
    const rooms = await prisma.room.findMany({
      where: {
        templateMapId: id,
        isPublic: true,
      },
      include: {
        world: {
          include: {
            universe: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
        _count: {
          select: {
            favorites: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return NextResponse.json({ rooms });
  } catch (error) {
    console.error('Error fetching rooms for map:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

