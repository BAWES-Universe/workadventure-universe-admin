import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

// GET /api/admin/users/[id]/worlds - Get list of worlds current user can invite this user to
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: userId } = await params;

    // Get all worlds where user is universe owner or world admin
    const worlds = await prisma.world.findMany({
      where: {
        OR: [
          {
            universe: {
              ownerId: sessionUser.id,
            },
          },
          {
            members: {
              some: {
                userId: sessionUser.id,
                tags: { has: 'admin' },
              },
            },
          },
        ],
      },
      include: {
        universe: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        members: {
          where: {
            userId: userId,
          },
        },
      },
    });

    // Filter out worlds where user is already a member
    const availableWorlds = worlds
      .filter(world => world.members.length === 0)
      .map(world => ({
        id: world.id,
        name: world.name,
        slug: world.slug,
        universe: world.universe,
      }));

    return NextResponse.json({ worlds: availableWorlds });
  } catch (error) {
    console.error('Error fetching worlds:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worlds' },
      { status: 500 }
    );
  }
}

