import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { parsePlayUri } from '@/lib/utils';
import { getSystemUserId, hiddenSystemOwnerId } from '@/lib/system-user';

// GET /api/admin/rooms/from-play-uri?playUri=<full_play_url>
export async function GET(request: NextRequest) {
  try {
    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') &&
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;

    if (!isAdminToken) {
      // Try to get user from session
      const { getSessionUser } = await import('@/lib/auth-session');
      const sessionUser = await getSessionUser(request);
      if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else {
      // Admin token - require it
      requireAuth(request);
    }

    const { searchParams } = new URL(request.url);
    const playUri = searchParams.get('playUri');

    if (!playUri) {
      return NextResponse.json(
        { error: 'Missing playUri parameter' },
        { status: 400 },
      );
    }

    let universeSlug: string;
    let worldSlug: string;
    let roomSlug: string;

    try {
      const parsed = parsePlayUri(playUri);
      universeSlug = parsed.universe;
      worldSlug = parsed.world;
      roomSlug = parsed.room;
    } catch (err) {
      return NextResponse.json(
        { error: 'Invalid playUri format' },
        { status: 400 },
      );
    }

    // Find world by universe/world slugs
    const world = await prisma.world.findFirst({
      where: {
        slug: worldSlug,
        universe: {
          slug: universeSlug,
        },
      },
      include: {
        universe: {
          select: {
            id: true,
            name: true,
            slug: true,
            ownerId: true,
          },
        },
      },
    });

    if (!world) {
      return NextResponse.json(
        { error: 'World not found for provided playUri' },
        { status: 404 },
      );
    }

    // Find room by slug within world
    const room = await prisma.room.findFirst({
      where: {
        slug: roomSlug,
        worldId: world.id,
      },
      include: {
        world: {
          select: {
            id: true,
            name: true,
            slug: true,
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
    });

    if (!room) {
      return NextResponse.json(
        { error: 'Room not found for provided playUri' },
        { status: 404 },
      );
    }

    // It still resolves by link; Home just says it isn't listed anywhere once System's spaces are hidden.
    const hidden = await hiddenSystemOwnerId();
    // Whether it is one of System's built-in rooms; the start room only counts as "the start map" when it is.
    let system = false;
    try {
      const systemId = await getSystemUserId();
      system = Boolean(systemId) && world.universe.ownerId === systemId;
    } catch (error) {
      console.warn('[from-play-uri] Could not tell whether the room is System’s', error);
    }
    return NextResponse.json({
      ...room,
      ...(hidden && world.universe.ownerId === hidden ? { unlisted: true } : {}),
      ...(system ? { system: true } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error resolving room from playUri:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}


