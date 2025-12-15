import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

// GET /api/memberships/my - Get current user's world memberships
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const memberships = await prisma.worldMember.findMany({
      where: {
        userId: sessionUser.id,
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
                ownerId: true,
              },
            },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    // Get last visited dates
    const worldIds = memberships.map(m => m.worldId);
    const lastVisits = await prisma.roomAccess.findMany({
      where: {
        worldId: { in: worldIds },
        userId: sessionUser.id,
      },
      select: {
        worldId: true,
        accessedAt: true,
      },
      orderBy: { accessedAt: 'desc' },
    });

    // Group by worldId and get most recent
    const lastVisitMap = new Map<string, Date>();
    for (const visit of lastVisits) {
      const existing = lastVisitMap.get(visit.worldId);
      if (!existing || visit.accessedAt > existing) {
        lastVisitMap.set(visit.worldId, visit.accessedAt);
      }
    }

    const membershipsWithLastVisit = memberships.map(membership => ({
      ...membership,
      lastVisited: lastVisitMap.get(membership.worldId) || null,
      isUniverseOwner: membership.world.universe.ownerId === sessionUser.id,
    }));

    return NextResponse.json({ memberships: membershipsWithLastVisit });
  } catch (error) {
    console.error('Error fetching memberships:', error);
    return NextResponse.json(
      { error: 'Failed to fetch memberships' },
      { status: 500 }
    );
  }
}

